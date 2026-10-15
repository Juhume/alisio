// Dirección de Home Assistant y token de acceso. Provisional hasta el inicio de sesión por
// el navegador (fase 2); después queda como plan B, para quien no pueda usar OAuth.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import {websocketUrl} from '../ha/client.js';
import {_} from './labels.js';

export interface ConnectRequest {
    url: string;
    /** null = conservar el token guardado. */
    token: string | null;
}

export function showConnectDialog(parent: Gtk.Widget, {url, hasToken, onSubmit}: {
    url: string;
    hasToken: boolean;
    onSubmit: (request: ConnectRequest) => void;
}): void {
    const dialog = new Adw.Dialog({title: _('Conexión'), content_width: 420});
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());

    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
        description: _('La dirección con la que abres Home Assistant en el navegador, por ejemplo http://192.168.1.10:8123.'),
    });
    const address = new Adw.EntryRow({title: _('Dirección'), text: url, input_purpose: Gtk.InputPurpose.URL});
    const token = new Adw.PasswordEntryRow({title: _('Token de acceso')});
    group.add(address);
    group.add(token);
    page.add(group);

    const help = new Adw.PreferencesGroup({
        description: _('Para crear un token: en Home Assistant, tu perfil → Seguridad → Tokens de acceso de larga duración → Crear token.'),
    });
    const openProfile = new Adw.ButtonRow({title: _('Abrir mi perfil de Home Assistant'), end_icon_name: 'adw-external-link-symbolic'});
    openProfile.connect('activated', () => {
        const base = address.text.trim().replace(/\/+$/, '');
        if (websocketUrl(base))
            new Gtk.UriLauncher({uri: `${base}/profile/security`}).launch(parent.get_root() as Gtk.Window, null, null);
        else
            address.add_css_class('error');
    });
    help.add(openProfile);
    page.add(help);

    const connect = new Gtk.Button({label: _('Conectar'), css_classes: ['suggested-action', 'pill'],
        halign: Gtk.Align.CENTER, margin_top: 6, margin_bottom: 24});
    // El token guardado es de esa dirección: con otra, hace falta uno nuevo.
    const same = (a: string) => a.trim().replace(/\/+$/, '').toLowerCase() === url.trim().replace(/\/+$/, '').toLowerCase();
    const needsToken = () => !hasToken || !same(address.text);
    const validate = () => {
        token.title = needsToken() ? _('Token de acceso') : _('Token nuevo (vacío: conservar el actual)');
        const ok = websocketUrl(address.text) !== null && (!needsToken() || token.text.trim() !== '');
        connect.sensitive = ok;
        return ok;
    };
    address.connect('changed', () => {
        address.remove_css_class('error');
        validate();
    });
    token.connect('changed', validate);
    validate();

    const submit = () => {
        if (!validate())
            return;
        onSubmit({url: address.text.trim().replace(/\/+$/, ''), token: token.text.trim() || null});
        dialog.close();
    };
    connect.connect('clicked', submit);
    token.connect('entry-activated', submit);
    address.connect('entry-activated', () => token.grab_focus());

    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    box.append(page);
    box.append(connect);
    page.vexpand = true;
    toolbar.content = box;
    dialog.child = toolbar;
    dialog.present(parent);
}
