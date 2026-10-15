// Ganchos de desarrollo, inertes salvo que se pidan por entorno:
//
//   ALISIO_STYLE=dark|light      fuerza el tema
//   ALISIO_SNAPSHOT=/ruta.png    cuando la ventana lleva un rato pintada, la guarda en PNG y sale
//   ALISIO_SNAPSHOT_DELAY=ms     espera antes de la foto (por defecto 1500)
//
// Sirve para revisar la ventana en claro y oscuro sin herramientas de captura, y para las
// capturas de la ficha de Flathub.

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk?version=4.0';

export function applyDevStyle(): void {
    const style = GLib.getenv('ALISIO_STYLE');
    if (style === 'dark' || style === 'light') {
        Adw.StyleManager.get_default().color_scheme = style === 'dark'
            ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT;
    }
}

export function scheduleSnapshot(window: Gtk.Window, quit: () => void): void {
    const path = GLib.getenv('ALISIO_SNAPSHOT');
    if (!path)
        return;
    const delay = Number(GLib.getenv('ALISIO_SNAPSHOT_DELAY') ?? 1500);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        try {
            savePng(window, path);
            print(`Captura: ${path}`);
        } catch (e) {
            logError(e as Error, 'No se pudo hacer la captura');
        }
        quit();
        return GLib.SOURCE_REMOVE;
    });
}

export function savePng(window: Gtk.Window, path: string): void {
    const width = window.get_width();
    const height = window.get_height();
    const paintable = new Gtk.WidgetPaintable({widget: window});
    const snapshot = new Gtk.Snapshot();
    paintable.snapshot(snapshot, width, height);
    const node = snapshot.to_node();
    if (!node)
        throw new Error('La ventana no tiene nada pintado');
    const renderer = window.get_native()!.get_renderer()!;
    const texture = renderer.render_texture(node, new Graphene.Rect().init(0, 0, width, height));
    texture.save_to_png(path);
}
