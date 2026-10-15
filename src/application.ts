// La aplicación: conecta el cliente de HA, el modelo y la ventana.
//
// Flujo de un gesto: la ventana avisa (onPower…) → el modelo decide la orden a partir del
// estado REAL (no del mostrado) → se apunta la expectativa optimista y se repinta → se
// envía → al confirmar o fallar, se ajusta la expectativa y se repinta otra vez.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {applyDevStyle, scheduleSnapshot} from './devtools.js';
import {HaClient, Status} from './ha/client.js';
import type {ServiceCall} from './ha/protocol.js';
import type {Climate} from './model/capabilities.js';
import {
    ModeMemory, allOff, buildHome, setFan, setPower, setSystemMode, setTarget, switchables,
    type Home, type Unit,
} from './model/home.js';
import {Optimistic, type Field} from './model/optimistic.js';
import {lookupToken, storeToken} from './secrets.js';
import {showConnectDialog} from './ui/connectDialog.js';
import {_} from './ui/labels.js';
import {AlisioWindow} from './ui/window.js';

export interface Config {
    appId: string;
    version: string;
    /** Solo pruebas: otra instancia aunque ya haya una abierta. */
    nonUnique?: boolean;
    /** Solo pruebas: de dónde sale el token (por defecto, el llavero). */
    tokenFor?: (url: string) => Promise<string | null>;
}

const now = () => GLib.get_monotonic_time() / 1000;

// Los tipos generados no ven las señales de la interfaz Gio.NetworkMonitor; de ahí el molde.
type SignalSource = {
    connect(signal: 'network-changed', callback: (monitor: unknown, available: boolean) => void): number;
    disconnect(id: number): void;
};
const networkMonitor = () => Gio.NetworkMonitor.get_default() as unknown as SignalSource;

export class AlisioApplication extends Adw.Application {
    static {
        GObject.registerClass(this);
    }

    private readonly _config: Config;
    private _settings!: Gio.Settings;
    private _window: AlisioWindow | null = null;

    get window(): AlisioWindow | null {
        return this._window;
    }
    /** Público para las pruebas de interfaz. */
    readonly client: HaClient;
    private readonly _memory = new ModeMemory();
    private readonly _optimistic = new Optimistic(now);
    private _home: Home = {units: []};
    private _redrawSource = 0;
    private _networkSignal = 0;

    constructor(config: Config) {
        super({application_id: config.appId,
            flags: config.nonUnique ? Gio.ApplicationFlags.NON_UNIQUE : Gio.ApplicationFlags.DEFAULT_FLAGS});
        this._config = config;
        this.client = new HaClient({
            onStatus: (status, detail) => this._onStatus(status, detail),
            onStates: () => this._onStates(),
        });
    }

    override vfunc_startup(): void {
        super.vfunc_startup();
        this._settings = new Gio.Settings({schema_id: this._config.appId});
        applyDevStyle();

        this._addAction('connection', () => this._openConnectDialog());
        this._addAction('about', () => this._showAbout());
        this._addAction('quit', () => this.quit());
        this.set_accels_for_action('app.quit', ['<Control>q']);
        this.set_accels_for_action('window.close', ['<Control>w']);

        // Al volver la red (wifi, Tailscale, salir de suspensión), reintentar ya.
        const monitor = networkMonitor();
        this._networkSignal = monitor.connect('network-changed', (_m, available) => {
            if (available)
                this.client.kick();
        });

        this._connect();
    }

    override vfunc_activate(): void {
        if (!this._window) {
            this._window = new AlisioWindow(this, this._settings, {
                onPower: (id, on) => this._withClimate(id, c => this._send(setPower(c, on, this._memory), id, 'on', on)),
                onTargetPreview: (id, value) => this._withClimate(id, c => {
                    if (c.target) {
                        this._optimistic.expect(id, 'targetValue', value);
                        this._redraw();
                    }
                }),
                onTargetCommit: (id, value) => this._withClimate(id, c => {
                    const call = setTarget(c, value);
                    if (call)
                        this._send(call, id, 'targetValue', call.data!.temperature as number);
                    else
                        this._optimistic.cancel(id, 'targetValue'); // volvió a la consigna de antes
                    this._redraw();
                }),
                onFan: (id, fan) => this._withClimate(id, c => this._send(setFan(c, fan), id, 'fan', fan)),
                onSystemMode: (machineId, mode) => {
                    const system = this._home.units.find(u => u.kind === 'shared' && u.machine.id === machineId);
                    if (system?.kind === 'shared')
                        this._send(setSystemMode(system, mode), machineId, 'mode', mode);
                },
                onAllOff: () => {
                    // Una orden por zona encendida; la ventana las ve apagarse una tras otra.
                    for (const call of allOff(this._home, this._memory))
                        this._send(call, call.target.entity_id[0], 'on', false);
                },
                onRetry: () => this.client.kick(),
                onConnectDialog: () => this._openConnectDialog(),
            });
            this._window.showStatus(this.client.status, null, this.client.retryDelay);
            this._redraw();
            scheduleSnapshot(this._window, () => this.quit());
        }
        this._window.present();
    }

    override vfunc_shutdown(): void {
        if (this._networkSignal)
            networkMonitor().disconnect(this._networkSignal);
        if (this._redrawSource)
            GLib.source_remove(this._redrawSource);
        this.client.destroy();
        super.vfunc_shutdown();
    }

    // --- Conexión -----------------------------------------------------------

    private async _connect(): Promise<void> {
        const url = this._settings.get_string('ha-url');
        let token: string | null = null;
        if (url) {
            try {
                token = await (this._config.tokenFor ?? lookupToken)(url);
            } catch (e) {
                logError(e as Error, 'No se pudo leer el llavero');
            }
        }
        this.client.connect(url || null, token);
    }

    private _openConnectDialog(): void {
        if (!this._window)
            this.activate();
        const url = this._settings.get_string('ha-url');
        showConnectDialog(this._window!, {
            url,
            hasToken: url !== '' && ![Status.NO_TOKEN, Status.AUTH_FAILED].includes(this.client.status as never),
            onSubmit: async ({url: newUrl, token}) => {
                try {
                    if (token)
                        await storeToken(newUrl, token);
                } catch (e) {
                    logError(e as Error, 'No se pudo guardar el token');
                    this._window?.toast(_('No se pudo guardar el token en el llavero'));
                    return;
                }
                this._settings.set_string('ha-url', newUrl);
                await this._connect();
            },
        });
    }

    private _onStatus(status: Status, detail: string | null): void {
        // Al conectar, los estados ya están en el cliente aunque onStates llegue después.
        this._home = buildHome(this.client.states, this.client.registry);
        this._window?.showStatus(status, detail, this.client.retryDelay);
        this._redraw();
    }

    private _onStates(): void {
        this._home = buildHome(this.client.states, this.client.registry);
        this._memory.observe(switchables(this._home));
        this._redraw();
    }

    // --- Órdenes ------------------------------------------------------------

    private _withClimate(id: string, action: (c: Climate) => void): void {
        const real = this._home.units.flatMap(u => u.kind === 'shared' ? [u.machine, ...u.zones] : [u.climate])
            .find(c => c.id === id);
        if (real)
            action(real);
    }

    private async _send(call: ServiceCall | null, id: string, field: Field, expected: Climate[Field]): Promise<void> {
        if (!call) {
            this._redraw(); // p. ej. el interruptor se movió pero no hay nada que hacer: vuelve a su sitio
            return;
        }
        this._optimistic.expect(id, field, expected);
        this._redraw();
        try {
            await this.client.callService(call);
            this._optimistic.confirmed(id, field);
        } catch (e) {
            this._optimistic.cancel(id, field);
            const name = this._nameOf(id);
            this._window?.toast(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
        this._redraw();
    }

    private _nameOf(id: string): string {
        let name = id;
        this._withClimate(id, c => (name = c.name));
        return name;
    }

    /** Pinta la casa con lo pedido encima, y programa el repintado de la próxima caducidad. */
    private _redraw(): void {
        if (!this._window)
            return;
        const view = (c: Climate) => this._optimistic.apply(c);
        const units: Unit[] = this._home.units.map(u => u.kind === 'shared'
            ? {...u, machine: view(u.machine), zones: u.zones.map(view)}
            : {...u, climate: view(u.climate)});
        const connected = this.client.status === Status.CONNECTED;
        if (connected || units.length)
            this._window.showHome({home: {units}, isPending: id => this._optimistic.isPending(id), enabled: connected});
        for (const {id} of this._optimistic.takeUnfulfilled())
            this._window.toast(`${this._nameOf(id)} ${_('no ha cambiado: el aparato no respondió')}`);

        if (this._redrawSource)
            GLib.source_remove(this._redrawSource);
        this._redrawSource = 0;
        const next = this._optimistic.nextDeadline();
        if (next !== null) {
            this._redrawSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.ceil(next - now())) + 10, () => {
                this._redrawSource = 0;
                this._redraw();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // --- Varios -------------------------------------------------------------

    private _addAction(name: string, activate: () => void): void {
        const action = new Gio.SimpleAction({name});
        action.connect('activate', activate);
        this.add_action(action);
    }

    private _showAbout(): void {
        const about = new Adw.AboutDialog({
            application_name: 'Alisio',
            application_icon: this._config.appId,
            developer_name: 'juhume',
            version: this._config.version,
            comments: _('El aire acondicionado de Home Assistant, desde el escritorio.'),
            website: 'https://github.com/juhume/alisio',
            issue_url: 'https://github.com/juhume/alisio/issues',
            license_type: Gtk.License.GPL_3_0,
        });
        about.present(this._window);
    }
}
