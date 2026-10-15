// La ventana: el modo de la máquina arriba, las zonas debajo, y los estados de conexión.
//
// La estructura (qué grupos y qué filas hay) solo se rehace cuando cambia el conjunto de
// climas; cada cambio de estado se limita a actualizar las filas existentes, así no se
// pierden el foco ni las filas desplegadas.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {Status} from '../ha/client.js';
import type {Climate} from '../model/capabilities.js';
import {switchables, type Home, type SharedSystem} from '../model/home.js';
import {_} from './labels.js';
import {MachineBar} from './machineBar.js';
import {ZoneRow, type ZoneHandlers} from './zoneRow.js';

export interface WindowHandlers extends ZoneHandlers {
    onSystemMode(machineId: string, mode: string): void;
    onAllOff(): void;
    onRetry(): void;
    onConnectDialog(): void;
}

export interface HomeView {
    home: Home;
    isPending(id: string): boolean;
    /** false mientras no hay conexión: se ve, pero no se toca. */
    enabled: boolean;
}

export class AlisioWindow extends Adw.ApplicationWindow {
    static {
        GObject.registerClass(this);
    }

    private readonly _handlers: WindowHandlers;
    private readonly _toasts = new Adw.ToastOverlay();
    private readonly _banner = new Adw.Banner();
    private readonly _stack = new Gtk.Stack({transition_type: Gtk.StackTransitionType.CROSSFADE});
    private readonly _homeBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 24,
        margin_top: 12, margin_bottom: 24, margin_start: 12, margin_end: 12, css_classes: ['home']});
    private readonly _rows = new Map<string, ZoneRow>();
    private readonly _machines = new Map<string, MachineBar>();
    private readonly _allOffButtons: Gtk.Button[] = [];
    private _signature = '';
    private _hasHome = false;
    private _bannerAction: (() => void) | null = null;
    private _countdownSource = 0;

    constructor(application: Adw.Application, settings: Gio.Settings, handlers: WindowHandlers) {
        super({application, title: 'Alisio', width_request: 360, height_request: 400});
        this._handlers = handlers;

        settings.bind('window-width', this, 'default-width', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('window-height', this, 'default-height', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('window-maximized', this, 'maximized', Gio.SettingsBindFlags.DEFAULT);

        const menu = new Gio.Menu();
        menu.append(_('Conexión…'), 'app.connection');
        menu.append(_('Acerca de Alisio'), 'app.about');
        const header = new Adw.HeaderBar();
        header.pack_end(new Gtk.MenuButton({icon_name: 'open-menu-symbolic', menu_model: menu,
            primary: true, tooltip_text: _('Menú principal')}));

        this._banner.connect('button-clicked', () => this._bannerAction?.());

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.add_top_bar(this._banner);
        toolbar.content = this._stack;
        this._toasts.child = toolbar;
        this.content = this._toasts;

        this._stack.add_named(this._statusPage(_('Conecta con Home Assistant'),
            _('Alisio necesita la dirección de tu Home Assistant y un token de acceso.'),
            _('Conectar…'), () => handlers.onConnectDialog()), 'setup');
        this._stack.add_named(new Adw.Spinner({width_request: 32, height_request: 32,
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER}), 'loading');
        this._stack.add_named(this._statusPage(_('No hay aires'),
            _('Home Assistant no tiene ninguna entidad de clima.'), null, null), 'empty');

        const clamp = new Adw.Clamp({maximum_size: 560, child: this._homeBox});
        this._stack.add_named(new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, child: clamp}), 'home');
        this._stack.visible_child_name = 'loading';

        this._setAccent('cool');
        this.connect('destroy', () => this._stopCountdown());
    }

    toast(text: string): void {
        this._toasts.add_toast(new Adw.Toast({title: text, timeout: 4}));
    }

    showStatus(status: Status, detail: string | null, retryDelay: number | null): void {
        this._stopCountdown();
        this._banner.revealed = false;
        this._bannerAction = null;

        switch (status) {
        case Status.CONNECTED:
            break; // la página la decide showHome: casa con aires o vacía
        case Status.CONNECTING:
        case Status.IDLE:
            if (!this._hasHome)
                this._stack.visible_child_name = 'loading';
            break;
        case Status.NO_TOKEN:
        case Status.BAD_URL:
            this._stack.visible_child_name = 'setup';
            break;
        case Status.AUTH_FAILED:
            this._showBanner(_('Home Assistant rechazó el token'), _('Cambiar…'), () => this._handlers.onConnectDialog());
            if (!this._hasHome)
                this._stack.visible_child_name = 'setup';
            break;
        case Status.OFFLINE:
            this._showOffline(detail, retryDelay);
            if (!this._hasHome)
                this._stack.visible_child_name = 'setup';
            break;
        }
    }

    showHome({home, isPending, enabled}: HomeView): void {
        const signature = home.units.map(u => u.kind === 'shared'
            ? `${u.machine.id}>${u.zones.map(z => z.id).join(',')}` : u.climate.id).join('|');
        if (signature !== this._signature) {
            this._signature = signature;
            this._rebuild(home);
        }
        this._hasHome = true;
        this._stack.visible_child_name = home.units.length ? 'home' : 'empty';
        if (home.units.length === 0)
            return;

        for (const unit of home.units) {
            if (unit.kind === 'shared')
                this._machines.get(unit.machine.id)?.update(unit.machine, enabled);
        }
        for (const c of switchables(home))
            this._rows.get(c.id)?.update(c, isPending(c.id), enabled);

        const anyOn = switchables(home).some(c => c.on);
        this._allOffButtons.forEach(b => {
            b.visible = anyOn;
            b.sensitive = enabled;
        });
        this._homeBox.remove_css_class('stale');
        if (!enabled)
            this._homeBox.add_css_class('stale');

        // El acento sigue al modo de la máquina; sin máquina, el turquesa de Alisio.
        const shared = home.units.find((u): u is SharedSystem => u.kind === 'shared');
        this._setAccent(shared?.machine.mode === 'heat' ? 'heat' : 'cool');
    }

    private _setAccent(mode: 'cool' | 'heat'): void {
        this.remove_css_class(mode === 'cool' ? 'mode-heat' : 'mode-cool');
        this.add_css_class(`mode-${mode}`);
    }

    private _rebuild(home: Home): void {
        for (let child = this._homeBox.get_first_child(); child; child = this._homeBox.get_first_child())
            this._homeBox.remove(child);
        this._rows.clear();
        this._machines.clear();
        this._allOffButtons.length = 0;

        const loose: Climate[] = [];
        for (const unit of home.units) {
            if (unit.kind === 'standalone') {
                loose.push(unit.climate);
                continue;
            }
            const bar = new MachineBar(unit.machine, mode => this._handlers.onSystemMode(unit.machine.id, mode));
            this._machines.set(unit.machine.id, bar);
            this._homeBox.append(bar);
            this._homeBox.append(this._group(_('Zonas'), unit.zones, this._allOffButtons.length === 0));
        }
        if (loose.length)
            this._homeBox.append(this._group(home.units.length > loose.length ? _('Otros aires') : _('Aires'), loose,
                this._allOffButtons.length === 0));
    }

    /** Un grupo de filas; el primero lleva "Apagar todo", que vale para toda la casa. */
    private _group(title: string, climates: Climate[], withAllOff: boolean): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title});
        if (withAllOff) {
            const allOff = new Gtk.Button({label: _('Apagar todo'), css_classes: ['flat'], valign: Gtk.Align.CENTER});
            allOff.connect('clicked', () => this._handlers.onAllOff());
            this._allOffButtons.push(allOff);
            group.header_suffix = allOff;
        }
        for (const c of climates) {
            const row = new ZoneRow(c, this._handlers);
            this._rows.set(c.id, row);
            group.add(row);
        }
        return group;
    }

    private _statusPage(title: string, description: string, button: string | null,
        action: (() => void) | null): Adw.StatusPage {
        const page = new Adw.StatusPage({title, description, icon_name: 'io.github.juhume.Alisio-symbolic'});
        if (button && action) {
            const b = new Gtk.Button({label: button, halign: Gtk.Align.CENTER, css_classes: ['suggested-action', 'pill']});
            b.connect('clicked', action);
            page.child = b;
        }
        return page;
    }

    private _showBanner(title: string, button: string, action: () => void): void {
        this._banner.title = title;
        this._banner.button_label = button;
        this._bannerAction = action;
        this._banner.revealed = true;
    }

    private _showOffline(detail: string | null, retryDelay: number | null): void {
        const reason = detail ?? _('Sin conexión con Home Assistant');
        let remaining = retryDelay ?? 0;
        const render = () => {
            const title = remaining > 0 ? `${reason} · ${_('reintento en')} ${remaining} s` : `${reason} · ${_('reintentando…')}`;
            this._showBanner(title, _('Reintentar'), () => this._handlers.onRetry());
        };
        render();
        if (remaining > 0) {
            this._countdownSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                remaining--;
                render();
                if (remaining > 0)
                    return GLib.SOURCE_CONTINUE;
                this._countdownSource = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _stopCountdown(): void {
        if (this._countdownSource)
            GLib.source_remove(this._countdownSource);
        this._countdownSource = 0;
    }
}
