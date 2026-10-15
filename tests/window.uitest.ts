// npm run test:ui — la ventana de verdad (GTK 4.24, libadwaita 1.10, dentro del Flatpak)
// contra la casa simulada en el mismo proceso. Mueve los controles con las mismas señales
// que un clic y comprueba qué órdenes llegan a HA y qué se pinta.
//
// Ajustes en memoria (GSETTINGS_BACKEND=memory) y token inyectado: no toca el llavero ni
// la configuración de la app instalada. Con ALISIO_SHOTS=/dir guarda capturas.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {AlisioApplication} from '../src/application.js';
import {savePng} from '../src/devtools.js';
import {Status} from '../src/ha/client.js';
import {ZoneRow} from '../src/ui/zoneRow.js';
import {check, run, section, sleep, until} from './harness.js';
import {COCINA, DESPACHO, MACHINE, SALON, koolnovaHouse} from './fixtures.js';
import {MockHa} from './mockHa.js';

const APP_ID = 'io.github.juhume.Alisio';
const shots = GLib.getenv('ALISIO_SHOTS');

// Los estilos de la app viven en su gresource; libadwaita carga su style.css al arrancar.
Gio.Resource.load(`/app/share/${APP_ID}/${APP_ID}.src.gresource`)._register();

const {states, platforms, cloud} = koolnovaHouse({on: [SALON]});
const ha = new MockHa({states, platforms, cloud});
new Gio.Settings({schema_id: APP_ID}).set_string('ha-url', ha.url);

const app = new AlisioApplication({appId: APP_ID, version: 'test', nonUnique: true,
    tokenFor: async () => 'buen-token'});
let win: Adw.ApplicationWindow;

// --- Buscar widgets como lo haría un usuario: por lo que se ve --------------

function* descendants(widget: Gtk.Widget): Generator<Gtk.Widget> {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield child;
        yield* descendants(child);
    }
}

function find<T extends Gtk.Widget>(root: Gtk.Widget, type: abstract new (...args: never[]) => T,
    pred: (w: T) => boolean = () => true): T | null {
    for (const w of descendants(root)) {
        if (w instanceof type && pred(w))
            return w;
    }
    return null;
}

const row = (name: string) => find(win, ZoneRow, r => r.title === name)!;
const switchOf = (name: string) => find(row(name), Gtk.Switch)!;
const spinnerOf = (name: string) => find(row(name), Adw.Spinner)!;
const targetOf = (name: string) => find(row(name), Adw.SpinRow)!;
const fanOf = (name: string) => find(row(name), Adw.ComboRow)!;
const modeGroup = () => find(win, Adw.ToggleGroup)!;
const callsTo = (service: string) => ha.calls.filter(c => c.service === service);
const zoneState = (id: string) => ha.states[id];

/** Captura (si se pidió), cuando la ventana ya está en pantalla y ha pintado lo último. */
async function shot(name: string) {
    if (!shots)
        return;
    await until(() => win.get_mapped());
    await sleep(350);
    savePng(win, `${shots}/${name}.png`);
}

async function testStartup() {
    section('Arranque');
    app.register(null);
    app.activate();
    win = app.window!;
    check(win !== null, 'abre la ventana');
    check(await until(() => app.client.status === Status.CONNECTED && find(win, ZoneRow) !== null),
        'conecta con el HA simulado y pinta las zonas');
    const rows = [...descendants(win)].filter((w): w is ZoneRow => w instanceof ZoneRow);
    check(rows.map(r => r.title).join() === 'Cocina,Despacho,Dormitorio,Invitados,Salón', 'cinco zonas, por nombre');
    check(switchOf('Salón').active && !switchOf('Despacho').active, 'Salón encendida, Despacho apagada');
    check(row('Salón').subtitle.includes('consigna 23'), 'subtítulo con lectura y consigna');
    check(modeGroup().active_name === 'cool', 'selector en Frío');
    check(win.has_css_class('mode-cool'), 'acento turquesa');
    check(cloud.requests === 0, 'abrir la ventana: 0 peticiones');
    await shot('1-inicio');
}

async function testPower() {
    section('Encender una zona');
    switchOf('Despacho').active = true;
    check(spinnerOf('Despacho').visible, 'al instante: "en curso"');
    check(await until(() => zoneState(DESPACHO).s === 'auto'), 'llega set_hvac_mode auto al despacho');
    check(await until(() => !spinnerOf('Despacho').visible), 'al llegar el estado, deja de estar en curso');
    check(switchOf('Despacho').active, 'y sigue encendida');
    check(cloud.requests === 1, '1 petición');
}

async function testTarget() {
    section('Consigna: cuatro clics, una orden');
    row('Despacho').expanded = true;
    const spin = targetOf('Despacho');
    check(spin.visible && spin.value === 23, 'consigna visible en 23');
    for (const v of [23.5, 24, 24.5, 25]) {
        spin.value = v;
        await sleep(150);
    }
    check(callsTo('set_temperature').length === 0, 'mientras se pulsa, no sale nada');
    check(await until(() => callsTo('set_temperature').length === 1, 2000), 'al parar, sale una sola orden');
    check(callsTo('set_temperature')[0]?.data.temperature === 25, 'con el valor final, 25');
    await sleep(300);
    check(spin.value === 25 && cloud.requests === 2, 'se queda en 25; 2 peticiones en total');
    await shot('2-detalle');
}

async function testFan() {
    section('Ventilador');
    const combo = fanOf('Despacho');
    check(combo.selected === 1, 'muestra "Medio"');
    combo.selected = 0;
    check(await until(() => zoneState(DESPACHO).a.fan_mode === 'low'), 'set_fan_mode low');
    check(cloud.requests === 3, '1 petición más');
    row('Despacho').expanded = false;
}

async function testMode() {
    section('Frío / Calor');
    const group = modeGroup();
    group.active_name = 'heat';
    check(group.active_name === 'cool', 'hasta confirmar, el selector sigue en Frío');
    const dialog = (win as Adw.ApplicationWindow).visible_dialog as Adw.AlertDialog | null;
    check(dialog instanceof Adw.AlertDialog, 'pide confirmación');
    check(callsTo('set_hvac_mode').filter(c => c.entity_id[0] === MACHINE).length === 0, 'sin confirmar, no sale nada');
    await shot('3-confirmar-calor');
    dialog?.emit('response', 'change');
    dialog?.close();
    check(await until(() => zoneState(MACHINE).s === 'heat'), 'confirmado: la máquina pasa a calor');
    check(await until(() => win.has_css_class('mode-heat') && group.active_name === 'heat'), 'acento ámbar y selector en Calor');
    check(cloud.requests === 4, 'una sola petición para toda la casa');
    await shot('4-calor');
    // Con todo apagado también debe verse el modo (Julio, prueba real: "no se ve en ámbar").
    check(group.has_css_class('mode-selector'), 'el selector lleva el color del modo');
}

async function testAllOff() {
    section('Apagar todo');
    const button = find(win, Gtk.Button, b => b.label === 'Apagar todo')!;
    check(button.visible, 'visible con zonas encendidas');
    button.emit('clicked');
    check(await until(() => zoneState(SALON).s === 'off' && zoneState(DESPACHO).s === 'off'), 'apaga Salón y Despacho');
    check(cloud.requests === 6, 'solo 2 peticiones: las zonas encendidas');
    check(await until(() => !button.visible), 'y el botón se esconde');
}

async function testFailure() {
    section('Una orden que falla');
    ha.failServices = true;
    switchOf('Cocina').active = true;
    check(await until(() => !switchOf('Cocina').active), 'el interruptor vuelve a su sitio');
    check(!spinnerOf('Cocina').visible, 'sin "en curso" colgado');
    check(zoneState(COCINA).s === 'off', 'la cocina sigue apagada');
    ha.failServices = false;
}

async function testSilentFailure() {
    section('HA dice "ok" pero el aparato no cambia (Koolnova, 15-10-2026)');
    ha.swallowServices = true;
    switchOf('Cocina').active = true;
    check(await until(() => !switchOf('Cocina').active, 8000), 'a los 5 s vuelve a lo real');
    const toast = () => find(win, Gtk.Label, l => l.label.includes('no respondió'));
    check(await until(() => toast() !== null), 'y avisa de que el aparato no respondió');
    check(toast()?.label.startsWith('Cocina') === true, `nombrando la zona: «${toast()?.label}»`);
    ha.swallowServices = false;
}

async function testOffline() {
    section('Sin conexión');
    const banner = find(win, Adw.Banner)!;
    ha.dropAll();
    check(await until(() => banner.revealed), 'aparece el aviso');
    check(banner.title.includes('reintento'), `explica qué pasa: «${banner.title}»`);
    check(!switchOf('Salón').sensitive, 'las zonas se ven pero no se tocan');
    await shot('5-sin-conexion');
    check(await until(() => !banner.revealed && switchOf('Salón').sensitive, 5000), 'vuelve solo');
}

run([
    testStartup, testPower, testTarget, testFan, testMode, testAllOff, testFailure, testSilentFailure,
    testOffline,
    () => {
        app.quit();
        ha.stop();
    },
]);
