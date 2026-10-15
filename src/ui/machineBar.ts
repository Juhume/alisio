// Frío / Calor de un sistema con modo compartido. Cambiarlo afecta a todas las zonas, así
// que se pide confirmación; hasta entonces el selector sigue mostrando el modo real.

import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import type {Climate} from '../model/capabilities.js';
import {_, modeLabel} from './labels.js';

export class MachineBar extends Gtk.Box {
    static {
        GObject.registerClass(this);
    }

    private readonly _group = new Adw.ToggleGroup({hexpand: true, homogeneous: true, css_classes: ['mode-selector']});
    private readonly _onMode: (mode: string) => void;
    private _modes: string[] = [];
    private _current = '';
    private _updating = false;

    constructor(machine: Climate, onMode: (mode: string) => void) {
        super({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        this._onMode = onMode;
        this.append(this._group);
        this._group.update_property([Gtk.AccessibleProperty.LABEL], [_('Modo de la máquina')]);
        this._group.connect('notify::active-name', () => {
            const chosen = this._group.active_name;
            if (this._updating || !chosen || chosen === this._current)
                return;
            this._setActive(this._current); // hasta confirmar, manda lo real
            this._confirm(chosen);
        });
        this.update(machine, true);
    }

    update(machine: Climate, enabled: boolean): void {
        if (machine.activeModes.join() !== this._modes.join()) {
            this._modes = [...machine.activeModes];
            this._updating = true;
            this._group.remove_all();
            for (const mode of this._modes)
                this._group.add(new Adw.Toggle({name: mode, label: modeLabel(mode)}));
            this._updating = false;
        }
        this._current = machine.mode;
        this._setActive(machine.mode);
        this._group.sensitive = enabled && machine.available;
    }

    private _setActive(mode: string): void {
        this._updating = true;
        this._group.active_name = this._modes.includes(mode) ? mode : null;
        this._updating = false;
    }

    private _confirm(mode: string): void {
        const label = modeLabel(mode).toLowerCase();
        const dialog = new Adw.AlertDialog({
            heading: `${_('¿Pasar a')} ${label}?`,
            body: _('El modo es de toda la máquina: cambia en todas las zonas.'),
            default_response: 'change',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', _('Cancelar'));
        dialog.add_response('change', `${_('Pasar a')} ${label}`);
        dialog.set_response_appearance('change', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_d, response) => {
            if (response === 'change')
                this._onMode(mode);
        });
        dialog.present(this);
    }
}
