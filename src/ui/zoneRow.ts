// Una zona (o un aire suelto): interruptor en la fila; consigna y ventilador al desplegar.
//
// La fila no decide nada: avisa de cada gesto y pinta lo que le dicen. La consigna se
// muestra al instante en cada clic y solo se envía 0,8 s después del último, para que
// subir de 23 a 25 sea una orden y no cuatro.

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import type {Climate} from '../model/capabilities.js';
import {_, degrees, fanLabel} from './labels.js';

const TARGET_SETTLE_MS = 800;

export interface ZoneHandlers {
    onPower(id: string, on: boolean): void;
    /** Cada clic en − / +: solo para mostrarlo. */
    onTargetPreview(id: string, value: number): void;
    /** El usuario dejó de tocar: ahora sí se envía. */
    onTargetCommit(id: string, value: number): void;
    onFan(id: string, fan: string): void;
}

export class ZoneRow extends Adw.ExpanderRow {
    static {
        GObject.registerClass(this);
    }

    private readonly _id: string;
    private readonly _handlers: ZoneHandlers;
    private readonly _spinner = new Adw.Spinner({visible: false});
    private readonly _switch = new Gtk.Switch({valign: Gtk.Align.CENTER});
    private readonly _target: Adw.SpinRow;
    private readonly _fan = new Adw.ComboRow({title: _('Ventilador')});
    private _fanModes: string[] = [];
    private _updating = false;
    private _settleSource = 0;

    constructor(climate: Climate, handlers: ZoneHandlers) {
        super({title: climate.name});
        this._id = climate.id;
        this._handlers = handlers;

        this.add_suffix(this._spinner);
        this.add_suffix(this._switch);
        this._switch.connect('notify::active', () => {
            if (!this._updating)
                this._handlers.onPower(this._id, this._switch.active);
        });
        // Que el lector de pantalla diga "Despacho, interruptor, activado".
        this._switch.update_property([Gtk.AccessibleProperty.LABEL], [climate.name]);

        this._target = new Adw.SpinRow({
            title: _('Consigna'),
            digits: 1,
            adjustment: new Gtk.Adjustment({lower: 16, upper: 27, step_increment: 0.5, page_increment: 1}),
        });
        this._target.connect('notify::value', () => {
            if (!this._updating)
                this._previewTarget(this._target.value);
        });
        this.add_row(this._target);

        this._fan.connect('notify::selected', () => {
            const fan = this._fanModes[this._fan.selected];
            if (!this._updating && fan)
                this._handlers.onFan(this._id, fan);
        });
        this.add_row(this._fan);

        this.connect('destroy', () => this._cancelSettle());
        this.update(climate, false, true);
    }

    update(c: Climate, pending: boolean, enabled: boolean): void {
        this._updating = true;
        try {
            this.subtitle = describe(c);
            this._spinner.visible = pending;

            this._switch.active = c.on;
            this._switch.sensitive = enabled && c.available && (c.on ? c.turnOff : c.turnOn) !== null;

            this._target.visible = c.target !== null;
            if (c.target) {
                const adj = this._target.adjustment;
                adj.lower = c.target.min;
                adj.upper = c.target.max;
                adj.step_increment = c.target.step;
                this._target.digits = Number.isInteger(c.target.step) ? 0 : 1;
                // Mientras el usuario está pulsando, manda lo que ve, no lo que llega.
                if (!this._settleSource && c.targetValue !== null)
                    this._target.value = c.targetValue;
            }
            this._target.sensitive = enabled && c.available;

            this._fan.visible = c.fanModes.length > 0;
            if (c.fanModes.join() !== this._fanModes.join()) {
                this._fanModes = [...c.fanModes];
                this._fan.model = Gtk.StringList.new(c.fanModes.map(fanLabel));
            }
            const fanIndex = c.fan ? this._fanModes.indexOf(c.fan) : -1;
            this._fan.selected = fanIndex >= 0 ? fanIndex : Gtk.INVALID_LIST_POSITION;
            this._fan.sensitive = enabled && c.available;

            this.enable_expansion = c.target !== null || c.fanModes.length > 0;
        } finally {
            this._updating = false;
        }
    }

    private _previewTarget(value: number): void {
        this._handlers.onTargetPreview(this._id, value);
        this._cancelSettle();
        this._settleSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TARGET_SETTLE_MS, () => {
            this._settleSource = 0;
            this._handlers.onTargetCommit(this._id, this._target.value);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _cancelSettle(): void {
        if (this._settleSource)
            GLib.source_remove(this._settleSource);
        this._settleSource = 0;
    }
}

function describe(c: Climate): string {
    if (!c.available)
        return _('No responde');
    const parts: string[] = [];
    if (c.current !== null)
        parts.push(degrees(c.current));
    if (c.on && c.targetValue !== null)
        parts.push(`${_('consigna')} ${degrees(c.targetValue)}`);
    if (!c.on)
        parts.push(_('apagada'));
    return parts.join(' · ');
}
