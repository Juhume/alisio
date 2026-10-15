// Cliente de la API WebSocket de Home Assistant.
//
// Nace del prototipo (~/Developer/aire, extension/lib/haClient.js) y conserva lo que ya
// estaba probado: reconexión con espera creciente, ping contra conexiones zombi, plazos
// en cada orden y un contador de generación que anula los callbacks de conexiones viejas.
// Solo depende de GLib, Gio y Soup: se prueba con gjs a secas contra tests/mockHa.ts.
//
// Al conectar: get_states (para saber qué climas hay) → registro de entidades (de qué
// integración es cada uno) → subscribe_entities solo de esos climas. HA empuja cada
// cambio; nunca se sondea. Leer es gratis: solo callService acaba en la nube del fabricante.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import type {
    EntitiesEvent, EntityState, IncomingMessage, RawRegistryDisplay, RawState,
    RegistryEntry, ServiceCall,
} from './protocol.js';

export const Status = Object.freeze({
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    OFFLINE: 'offline', // caído o inalcanzable; reintenta solo
    NO_TOKEN: 'no-token',
    AUTH_FAILED: 'auth-failed', // HA rechazó el token; no reintenta hasta que cambie
    BAD_URL: 'bad-url',
});
export type Status = typeof Status[keyof typeof Status];

const BACKOFF_S = [1, 2, 5, 10, 30, 60];
const HANDSHAKE_TIMEOUT_S = 20;
const PING_INTERVAL_S = 30;
const REQUEST_TIMEOUT_S = 20;
const MAX_PAYLOAD = 16 * 1024 * 1024; // get_states de una casa grande cabe de sobra

const decoder = new TextDecoder();

/**
 * Traza del protocolo para depurar (G_MESSAGES_DEBUG=Alisio): tipos, ids, tamaños y tiempos.
 * Nunca contenidos: así no puede acabar un token en un registro.
 */
const t0 = GLib.get_monotonic_time();
function trace(text: string): void {
    console.debug(`[ha +${Math.round((GLib.get_monotonic_time() - t0) / 1000)} ms] ${text}`);
}

export function websocketUrl(baseUrl: string): string | null {
    const match = baseUrl.trim().replace(/\/+$/, '').match(/^(https?):\/\/([^/\s]+)$/i);
    if (!match)
        return null;
    const scheme = match[1].toLowerCase() === 'https' ? 'wss' : 'ws';
    return `${scheme}://${match[2]}/api/websocket`;
}

export interface HaClientOptions {
    /** Dominios a los que suscribirse; por defecto, solo los climas. */
    domains?: string[];
    onStatus?: (status: Status, detail: string | null) => void;
    onStates?: (states: ReadonlyMap<string, EntityState>) => void;
}

interface Pending {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeout: number;
}

export class HaClient {
    private readonly _domains: string[];
    private _onStatus: NonNullable<HaClientOptions['onStatus']>;
    private _onStates: NonNullable<HaClientOptions['onStates']>;

    private readonly _session = new Soup.Session();
    private readonly _states = new Map<string, EntityState>();
    private readonly _registry = new Map<string, RegistryEntry>();
    private readonly _pending = new Map<number, Pending>();
    private _status: Status = Status.IDLE;

    private _wsUrl: string | null = null;
    private _token: string | null = null;
    private _generation = 0; // invalida callbacks de conexiones anteriores
    private _attempt = 0;
    private _nextId = 1;
    private _subscriptionId: number | null = null;
    private _awaitingSnapshot = false; // la primera foto de cada suscripción sustituye a la anterior

    private _conn: Soup.WebsocketConnection | null = null;
    private _connSignals: number[] = [];
    private _cancellable: Gio.Cancellable | null = null;
    private _lastError: string | null = null;
    private _retrySource = 0;
    private _handshakeSource = 0;
    private _pingSource = 0;
    private _awaitingPong = false;

    constructor({domains = ['climate'], onStatus = () => {}, onStates = () => {}}: HaClientOptions = {}) {
        this._domains = domains;
        this._onStatus = onStatus;
        this._onStates = onStates;
    }

    get status(): Status {
        return this._status;
    }

    get states(): ReadonlyMap<string, EntityState> {
        return this._states;
    }

    /** Integración, dispositivo y área de cada entidad suscrita (vacío si HA no lo da). */
    get registry(): ReadonlyMap<string, RegistryEntry> {
        return this._registry;
    }

    /** Segundos hasta el próximo reintento, o null si no hay ninguno programado. */
    get retryDelay(): number | null {
        return this._retrySource ? BACKOFF_S[Math.min(this._attempt - 1, BACKOFF_S.length - 1)] : null;
    }

    connect(baseUrl: string | null, token: string | null): void {
        this._teardown();
        this._cancelRetry();
        this._attempt = 0;
        this._states.clear();
        this._registry.clear();

        this._token = token?.trim() || null;
        this._wsUrl = websocketUrl(baseUrl ?? '');

        if (!this._wsUrl)
            this._setStatus(Status.BAD_URL, baseUrl);
        else if (!this._token)
            this._setStatus(Status.NO_TOKEN);
        else
            this._open();
    }

    disconnect(): void {
        this._teardown();
        this._cancelRetry();
        this._setStatus(Status.IDLE);
    }

    /** Si estamos esperando para reintentar, reintenta ya (red recuperada, ventana abierta…). */
    kick(): void {
        if (this._status !== Status.OFFLINE)
            return;
        this._cancelRetry();
        this._attempt = 0;
        this._open();
    }

    destroy(): void {
        this.disconnect();
        this._session.abort();
        this._onStatus = this._onStates = () => {};
    }

    /** Una orden a HA. Es lo único que puede acabar en la nube del fabricante. */
    async callService({domain, service, target, data}: ServiceCall): Promise<void> {
        if (this._status !== Status.CONNECTED)
            throw new Error('Sin conexión con Home Assistant');
        await this._request({
            type: 'call_service',
            domain,
            service,
            target,
            ...(data ? {service_data: data} : {}),
        });
    }

    /** Petición genérica (lecturas de registros, etc.). Resuelve con el `result` de HA. */
    command<T = unknown>(payload: Record<string, unknown>): Promise<T> {
        if (this._status !== Status.CONNECTED)
            return Promise.reject(new Error('Sin conexión con Home Assistant'));
        return this._request(payload) as Promise<T>;
    }

    // --- Conexión -----------------------------------------------------------

    private _open(): void {
        this._teardown();
        const generation = this._generation;
        this._setStatus(Status.CONNECTING);

        let message: Soup.Message | null;
        try {
            message = Soup.Message.new('GET', this._wsUrl!);
        } catch {
            message = null;
        }
        if (!message) {
            this._setStatus(Status.BAD_URL, this._wsUrl);
            return;
        }

        this._cancellable = new Gio.Cancellable();
        this._session.websocket_connect_async(message, null, null, GLib.PRIORITY_DEFAULT,
            this._cancellable, (session, result) => {
                let conn: Soup.WebsocketConnection;
                try {
                    conn = session!.websocket_connect_finish(result);
                } catch (e) {
                    if (generation === this._generation)
                        this._fail(describeError(e));
                    return;
                }
                if (generation !== this._generation) {
                    conn.close(Soup.WebsocketCloseCode.NORMAL, null);
                    return;
                }
                this._attach(conn, generation);
            });

        this._handshakeSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HANDSHAKE_TIMEOUT_S, () => {
            this._handshakeSource = 0;
            this._fail('Home Assistant no contesta');
            return GLib.SOURCE_REMOVE;
        });
    }

    private _attach(conn: Soup.WebsocketConnection, generation: number): void {
        this._conn = conn;
        conn.max_incoming_payload_size = MAX_PAYLOAD;
        this._connSignals = [
            conn.connect('message', (_c, type, bytes) => {
                if (generation === this._generation && type === Soup.WebsocketDataType.TEXT)
                    this._onMessage(decoder.decode(bytes.toArray()));
            }),
            conn.connect('error', (_c, error) => {
                this._lastError = describeError(error);
                trace(`error de WebSocket: ${this._lastError}`);
            }),
            conn.connect('closed', () => {
                if (generation === this._generation)
                    this._fail(this._lastError ?? 'Conexión cerrada');
            }),
        ];
    }

    private _teardown(): void {
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;

        if (this._conn) {
            this._connSignals.forEach(id => this._conn!.disconnect(id));
            if (this._conn.get_state() === Soup.WebsocketState.OPEN)
                this._conn.close(Soup.WebsocketCloseCode.NORMAL, null);
            this._conn = null;
        }
        this._connSignals = [];
        this._lastError = null;
        this._subscriptionId = null;
        this._awaitingPong = false;

        if (this._handshakeSource)
            GLib.source_remove(this._handshakeSource);
        if (this._pingSource)
            GLib.source_remove(this._pingSource);
        this._handshakeSource = this._pingSource = 0;

        for (const id of [...this._pending.keys()])
            this._settle(id, new Error('Se perdió la conexión con Home Assistant'));
    }

    private _fail(reason: string): void {
        trace(`fallo: ${reason}`);
        this._teardown();
        const delay = BACKOFF_S[Math.min(this._attempt, BACKOFF_S.length - 1)];
        this._attempt++;
        this._retrySource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retrySource = 0;
            this._open();
            return GLib.SOURCE_REMOVE;
        });
        this._setStatus(Status.OFFLINE, reason);
    }

    private _cancelRetry(): void {
        if (this._retrySource)
            GLib.source_remove(this._retrySource);
        this._retrySource = 0;
    }

    private _setStatus(status: Status, detail: string | null = null): void {
        this._status = status;
        this._onStatus(status, detail);
    }

    // --- Protocolo ----------------------------------------------------------

    private _send(payload: Record<string, unknown>): number {
        const id = this._nextId++;
        trace(`→ ${payload.type} #${id}`);
        this._conn!.send_text(JSON.stringify({...payload, id}));
        return id;
    }

    private _request(payload: Record<string, unknown>): Promise<unknown> {
        if (!this._conn)
            return Promise.reject(new Error('Sin conexión con Home Assistant'));
        return new Promise((resolve, reject) => {
            const id = this._send(payload);
            const pending: Pending = {resolve, reject, timeout: 0};
            pending.timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_S, () => {
                pending.timeout = 0;
                this._settle(id, new Error('Home Assistant no respondió a tiempo'));
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(id, pending);
        });
    }

    private _onMessage(text: string): void {
        let parsed: IncomingMessage | IncomingMessage[];
        try {
            parsed = JSON.parse(text);
        } catch {
            trace(`← JSON ilegible (${text.length} bytes)`);
            return;
        }
        for (const m of Array.isArray(parsed) ? parsed : [parsed])
            trace(`← ${m.type}${'id' in m ? ` #${m.id}` : ''}${m.type === 'result' ? (m.success ? ' ok' : ` error ${m.error?.code}`) : ''} (${text.length} bytes)`);
        // HA puede agrupar mensajes en un array si se le pide; lo aceptamos por si acaso.
        for (const message of Array.isArray(parsed) ? parsed : [parsed])
            this._handle(message);
    }

    private _handle(message: IncomingMessage): void {
        switch (message.type) {
        case 'auth_required':
            trace('→ auth (contenido omitido)');
            this._conn!.send_text(JSON.stringify({type: 'auth', access_token: this._token}));
            break;

        case 'auth_ok': {
            const generation = this._generation;
            this._bootstrap(generation).catch(e => {
                // Un rechazo por teardown llega con la generación ya caducada: se ignora.
                if (generation === this._generation)
                    this._fail(e instanceof Error ? e.message : String(e));
            });
            break;
        }

        case 'auth_invalid':
            this._teardown();
            this._setStatus(Status.AUTH_FAILED, message.message ?? null);
            break;

        case 'event':
            if (message.id === this._subscriptionId)
                this._applyEntityEvent(message.event);
            break;

        case 'result':
            if (message.id === this._subscriptionId) {
                if (!message.success)
                    this._fail(message.error?.message ?? 'Suscripción rechazada');
            } else {
                this._settle(message.id, message.success
                    ? null : new Error(message.error?.message ?? 'Error de Home Assistant'), message.result);
            }
            break;

        case 'pong':
            this._awaitingPong = false;
            break;
        }
    }

    /** Tras autenticar: qué entidades hay, de qué integración son, y suscripción a ellas. */
    private async _bootstrap(generation: number): Promise<void> {
        const states = await this._request({type: 'get_states'}) as RawState[];
        if (generation !== this._generation)
            return;
        const ids = states.map(s => s.entity_id)
            .filter(id => this._domains.includes(id.slice(0, id.indexOf('.'))));

        // El registro es un extra: si falla (HA antiguo, permisos), seguimos sin él.
        let display: RawRegistryDisplay | null = null;
        try {
            display = await this._request({type: 'config/entity_registry/list_for_display'}) as RawRegistryDisplay;
        } catch {
            display = null;
        }
        if (generation !== this._generation)
            return;
        this._registry.clear();
        const wanted = new Set(ids);
        for (const e of display?.entities ?? []) {
            if (wanted.has(e.ei))
                this._registry.set(e.ei, {platform: e.pl ?? null, deviceId: e.di ?? null, areaId: e.ai ?? null});
        }

        // Ojo: subscribe_entities con la lista vacía se suscribiría a TODO. Sin climas, no hay
        // nada que escuchar: se da por conectado con la casa vacía.
        if (ids.length === 0) {
            this._states.clear();
            this._markConnected();
            this._onStates(this._states);
            return;
        }
        this._awaitingSnapshot = true;
        this._subscriptionId = this._send({type: 'subscribe_entities', entity_ids: ids});
    }

    // Formato comprimido de subscribe_entities:
    //   a: {id: {s, a, …}}                       estados completos (primer mensaje y altas)
    //   c: {id: {'+': {s?, a?}, '-': {a: []}}}   diferencias
    //   r: [id]                                  bajas
    private _applyEntityEvent(event: EntitiesEvent): void {
        // Tras reconectar, lo que se borró en HA mientras tanto no debe quedarse aquí.
        if (this._awaitingSnapshot) {
            this._awaitingSnapshot = false;
            this._states.clear();
        }
        for (const [id, full] of Object.entries(event.a ?? {}))
            this._states.set(id, {state: full.s, attributes: full.a ?? {}});

        for (const [id, diff] of Object.entries(event.c ?? {})) {
            const current = this._states.get(id);
            if (!current)
                continue;
            const next = {state: current.state, attributes: {...current.attributes}};
            if (diff['+']?.s !== undefined)
                next.state = diff['+'].s;
            Object.assign(next.attributes, diff['+']?.a ?? {});
            for (const key of diff['-']?.a ?? [])
                delete next.attributes[key];
            this._states.set(id, next);
        }

        for (const id of event.r ?? [])
            this._states.delete(id);

        if (this._status !== Status.CONNECTED)
            this._markConnected();
        this._onStates(this._states);
    }

    private _markConnected(): void {
        this._attempt = 0;
        if (this._handshakeSource)
            GLib.source_remove(this._handshakeSource);
        this._handshakeSource = 0;
        this._startPing();
        this._setStatus(Status.CONNECTED);
    }

    private _startPing(): void {
        this._pingSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PING_INTERVAL_S, () => {
            if (this._awaitingPong) {
                this._pingSource = 0;
                this._fail('Home Assistant dejó de responder');
                return GLib.SOURCE_REMOVE;
            }
            this._awaitingPong = true;
            this._send({type: 'ping'});
            return GLib.SOURCE_CONTINUE;
        });
    }

    private _settle(id: number, error: Error | null, result: unknown = null): void {
        const pending = this._pending.get(id);
        if (!pending)
            return;
        this._pending.delete(id);
        if (pending.timeout)
            GLib.source_remove(pending.timeout);
        if (error)
            pending.reject(error);
        else
            pending.resolve(result);
    }
}

function describeError(error: unknown): string {
    if (error instanceof GLib.Error) {
        if (error.matches(Gio.ResolverError, Gio.ResolverError.NOT_FOUND))
            return 'No se encuentra el servidor (¿Tailscale apagado?)';
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED))
            return 'Conexión rechazada';
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
