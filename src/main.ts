// Punto de entrada. El lanzador (src/io.github.juhume.Alisio.in) carga el gresource e
// importa este módulo con la configuración que pone meson al instalar.

import GLib from 'gi://GLib';
import Gettext from 'gettext';

import {AlisioApplication} from './application.js';
import {runInventory} from './inventory.js';

export interface LaunchConfig {
    appId: string;
    version: string;
    localedir: string;
}

export async function main(argv: string[], config: LaunchConfig): Promise<number> {
    Gettext.bindtextdomain(config.appId, config.localedir);
    Gettext.textdomain(config.appId);
    GLib.set_application_name('Alisio');

    if (argv.includes('--inventario'))
        return runInventory(config.appId);

    const app = new AlisioApplication(config);
    return app.runAsync(argv);
}
