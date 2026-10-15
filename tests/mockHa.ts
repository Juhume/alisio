// Home Assistant de mentira: habla el mismo protocolo WebSocket que el real (auth,
// get_states, registro de entidades, subscribe_entities comprimido, call_service, ping)
// con un estado en memoria. Los climas se comportan como en HA; los de Koolnova, además,
// como la integración de casa (ver KoolnovaCloud).

import Soup from 'gi://Soup?version=3.0';

import type {Attributes} from '../src/ha/protocol.js';
import {Feature} from '../src/model/capabilities.js';

const decoder = new TextDecoder();

export interface MockState {
    s: string;
    a: Attributes;
}

export interface MockCall {
    domain: string;
    service: string;
    entity_id: string[];
    data: Record<string, unknown>;
}

export interface MockOptions {
    token?: string;
    states?: Record<string, MockState>;
    /** entity_id → integración, para `list_for_display`. */
    platforms?: Record<string, string>;
    failServices?: boolean;
    /** Sin registro de entidades (HA antiguo o sin permiso). */
    noRegistry?: boolean;
    cloud?: KoolnovaCloud;
    port?: number;
}

interface Client {
    conn: Soup.WebsocketConnection;
    authed: boolean;
    subId: number | null;
    subscribed: Set<string>;
}

class ServiceError extends Error {
    constructor(message: string, readonly code = 'home_assistant_error') {
        super(message);
    }
}

export class MockHa {
    readonly token: string;
    readonly states: Record<string, MockState>;
    readonly platforms: Record<string, string>;
    readonly calls: MockCall[] = [];
    readonly cloud: KoolnovaCloud | null;
    readonly port: number;
    readonly url: string;
    failServices: boolean;
    /** Como Koolnova cuando su nube corta: HA responde "ok" pero nada cambia. */
    swallowServices = false;
    noRegistry: boolean;
    /** Mensajes recibidos de los clientes, por tipo (para afirmar que no se sondea). */
    readonly received: Record<string, number> = {};

    private readonly _clients = new Set<Client>();
    private readonly _server = new Soup.Server();

    constructor({token = 'buen-token', states = {}, platforms = {}, failServices = false,
        noRegistry = false, cloud, port = 0}: MockOptions = {}) {
        this.token = token;
        this.states = JSON.parse(JSON.stringify(states));
        this.platforms = platforms;
        this.failServices = failServices;
        this.noRegistry = noRegistry;
        this.cloud = cloud ?? null;

        this._server.add_websocket_handler('/api/websocket', null, null, (_s, _msg, _path, conn) => {
            this._accept(conn);
        });
        this._server.listen_local(port, Soup.ServerListenOptions.IPV4_ONLY);
        this.port = this._server.get_uris()[0].get_port();
        this.url = `http://127.0.0.1:${this.port}`;
    }

    get clientCount(): number {
        return this._clients.size;
    }

    private _accept(conn: Soup.WebsocketConnection): void {
        const client: Client = {conn, authed: false, subId: null, subscribed: new Set()};
        this._clients.add(client);
        conn.connect('closed', () => this._clients.delete(client));
        conn.connect('message', (_c, _type, bytes) => this._handle(client, JSON.parse(decoder.decode(bytes.toArray()))));
        this._sendTo(client, {type: 'auth_required', ha_version: 'mock'});
    }

    private _sendTo(client: Client, payload: unknown): void {
        client.conn.send_text(JSON.stringify(payload));
    }

    private _result(client: Client, id: number, result: unknown = null): void {
        this._sendTo(client, {id, type: 'result', success: true, result});
    }

    private _error(client: Client, id: number, message: string, code = 'home_assistant_error'): void {
        this._sendTo(client, {id, type: 'result', success: false, error: {code, message}});
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _handle(client: Client, msg: any): void {
        this.received[msg.type] = (this.received[msg.type] ?? 0) + 1;

        if (msg.type === 'auth') {
            if (msg.access_token === this.token) {
                client.authed = true;
                this._sendTo(client, {type: 'auth_ok', ha_version: 'mock'});
            } else {
                this._sendTo(client, {type: 'auth_invalid', message: 'Invalid access token or password'});
                client.conn.close(1000, null);
            }
            return;
        }
        if (!client.authed)
            return;

        switch (msg.type) {
        case 'get_states':
            this._result(client, msg.id, Object.entries(this.states)
                .map(([entity_id, {s, a}]) => ({entity_id, state: s, attributes: a})));
            break;

        case 'config/entity_registry/list_for_display':
            if (this.noRegistry) {
                this._error(client, msg.id, 'Unknown command.', 'unknown_command');
                break;
            }
            this._result(client, msg.id, {
                entity_categories: {},
                entities: Object.keys(this.states).map(ei => ({ei, ...(this.platforms[ei] ? {pl: this.platforms[ei]} : {})})),
            });
            break;

        case 'subscribe_entities': {
            // Como HA: sin lista, TODO. El cliente nunca debe pedirlo así.
            const ids: string[] = msg.entity_ids?.length ? msg.entity_ids : Object.keys(this.states);
            client.subId = msg.id;
            client.subscribed = new Set(ids);
            this._result(client, msg.id);
            const a = Object.fromEntries(ids.filter(id => id in this.states).map(id => [id, this.states[id]]));
            this._sendTo(client, {id: msg.id, type: 'event', event: {a}});
            break;
        }

        case 'call_service': {
            const entityIds: string[] = msg.target?.entity_id ?? [];
            const data = msg.service_data ?? {};
            this.calls.push({domain: msg.domain, service: msg.service, entity_id: entityIds, data});
            try {
                if (this.failServices)
                    throw new ServiceError('Koolnova dijo que no');
                if (this.swallowServices) {
                    this._result(client, msg.id, {context: {}});
                    break;
                }
                for (const id of entityIds)
                    this._apply(msg.domain, msg.service, id, data);
                this._result(client, msg.id, {context: {}});
            } catch (e) {
                const error = e instanceof ServiceError ? e : new ServiceError(String(e));
                this._error(client, msg.id, error.message, error.code);
            }
            break;
        }

        case 'ping':
            this._sendTo(client, {id: msg.id, type: 'pong'});
            break;

        default:
            this._error(client, msg.id, 'Unknown command.', 'unknown_command');
        }
    }

    private _apply(domain: string, service: string, id: string, data: Record<string, unknown>): void {
        const entity = this.states[id];
        if (!entity)
            throw new ServiceError(`Entity ${id} not found`);

        if (domain === 'switch') {
            this.setState(id, service === 'turn_on' ? 'on' : 'off');
            return;
        }
        if (domain !== 'climate')
            throw new ServiceError(`Service ${domain}.${service} not found`, 'service_not_found');

        if (this.cloud?.owns(id)) {
            this.cloud.apply(this, id, service, data);
            return;
        }
        applyClimate(this, id, service, data);
    }

    /** Cambia un estado y lo difunde como diferencia, igual que HA. */
    setState(id: string, state: string, attributes?: Attributes): void {
        const previous = this.states[id];
        this.states[id] = {s: state, a: {...(previous?.a ?? {}), ...(attributes ?? {})}};
        const plus: {s: string; a?: Attributes} = {s: state};
        if (attributes)
            plus.a = attributes;
        for (const client of this._clients) {
            if (client.subId !== null && client.subscribed.has(id))
                this._sendTo(client, {id: client.subId, type: 'event', event: {c: {[id]: {'+': plus}}}});
        }
    }

    setAttributes(id: string, attributes: Attributes): void {
        this.setState(id, this.states[id].s, attributes);
    }

    dropAll(): void {
        for (const client of this._clients)
            client.conn.close(1001, null);
    }

    stop(): void {
        this._server.disconnect();
    }
}

// --- Climas genéricos, como los valida HA -----------------------------------


function applyClimate(ha: MockHa, id: string, service: string, data: Record<string, unknown>): void {
    const {s, a} = ha.states[id];
    const features = Number(a.supported_features ?? 0);
    const need = (flag: number) => {
        if (!(features & flag))
            throw new ServiceError(`Entity ${id} does not support this service.`, 'not_supported');
    };

    switch (service) {
    case 'set_hvac_mode': {
        const mode = String(data.hvac_mode);
        if (!(a.hvac_modes as string[] | undefined)?.includes(mode))
            throw new ServiceError(`HVAC mode ${mode} is not valid`, 'not_valid_hvac_mode');
        ha.setState(id, mode);
        break;
    }
    case 'set_temperature':
        need(Feature.TARGET_TEMPERATURE);
        ha.setAttributes(id, {temperature: Number(data.temperature)});
        if (data.hvac_mode)
            ha.setState(id, String(data.hvac_mode));
        break;
    case 'set_fan_mode':
        need(Feature.FAN_MODE);
        ha.setAttributes(id, {fan_mode: data.fan_mode});
        break;
    case 'set_preset_mode':
        need(Feature.PRESET_MODE);
        ha.setAttributes(id, {preset_mode: data.preset_mode});
        break;
    case 'turn_on':
        need(Feature.TURN_ON);
        if (s === 'off')
            ha.setState(id, String((a.hvac_modes as string[]).find(m => m !== 'off')));
        break;
    case 'turn_off':
        need(Feature.TURN_OFF);
        ha.setState(id, 'off');
        break;
    default:
        throw new ServiceError(`Service climate.${service} not found`, 'service_not_found');
    }
}

// --- Koolnova ----------------------------------------------------------------

/**
 * La nube de Koolnova tal como la usa la integración de casa (custom_components/koolnova):
 * cada orden a una zona es 1 petición; la consigna, el ventilador y el "modo de zonas" de
 * la máquina se repiten en las 5 zonas (5 peticiones) y la máquina guarda lo último pedido.
 * Si en un minuto pasan más de `limit` peticiones, bloquea, como hizo en junio de 2026.
 */
export class KoolnovaCloud {
    requests = 0;
    blocked = false;
    private readonly _times: number[] = [];

    constructor(readonly machine: string, readonly zones: string[], readonly limit = 12) {}

    owns(id: string): boolean {
        return id === this.machine || this.zones.includes(id);
    }

    private _request(): void {
        const now = Date.now();
        while (this._times.length && now - this._times[0] > 60_000)
            this._times.shift();
        this.requests++;
        this._times.push(now);
        if (this._times.length > this.limit)
            this.blocked = true;
        if (this.blocked)
            throw new ServiceError('Koolnova: demasiadas peticiones, IP bloqueada');
    }

    apply(ha: MockHa, id: string, service: string, data: Record<string, unknown>): void {
        const isMachine = id === this.machine;
        const {a} = ha.states[id];
        switch (service) {
        case 'set_hvac_mode': {
            const mode = String(data.hvac_mode);
            if (!(a.hvac_modes as string[]).includes(mode))
                throw new ServiceError(`Unsupported HVAC mode: ${mode}`);
            this._request();
            ha.setState(id, mode);
            break;
        }
        case 'set_temperature':
            if (isMachine) {
                for (const zone of this.zones) {
                    this._request();
                    ha.setAttributes(zone, {temperature: Number(data.temperature)});
                }
            } else {
                this._request();
            }
            ha.setAttributes(id, {temperature: Number(data.temperature)});
            break;
        case 'set_fan_mode':
            if (isMachine) {
                for (const zone of this.zones) {
                    this._request();
                    ha.setAttributes(zone, {fan_mode: data.fan_mode});
                }
            } else {
                this._request();
            }
            ha.setAttributes(id, {fan_mode: data.fan_mode});
            break;
        case 'set_preset_mode':
            if (!isMachine)
                throw new ServiceError(`Entity ${id} does not support this service.`, 'not_supported');
            for (const zone of this.zones) {
                this._request();
                ha.setState(zone, String(data.preset_mode));
            }
            ha.setAttributes(id, {preset_mode: data.preset_mode});
            break;
        default:
            throw new ServiceError(`Entity ${id} does not support this service.`, 'not_supported');
        }
    }
}
