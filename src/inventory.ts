// `alisio --inventario`: lo que Alisio ve en Home Assistant, en texto, y nada más.
// Lee estados y registro (gratis: HA los tiene en memoria). No llama a ningún servicio,
// así que no llega ni una petición a la nube del fabricante. No imprime credenciales.

import Gio from 'gi://Gio';

import {HaClient, Status} from './ha/client.js';
import {describeClimate, Feature, type Climate} from './model/capabilities.js';
import {buildHome, systemFan} from './model/home.js';
import {lookupToken} from './secrets.js';

const FEATURE_NAMES = Object.entries(Feature);

export async function runInventory(appId: string): Promise<number> {
    const url = new Gio.Settings({schema_id: appId}).get_string('ha-url');
    if (!url) {
        printerr('Sin dirección de Home Assistant: conecta primero desde la ventana.');
        return 1;
    }
    const token = await lookupToken(url);
    if (!token) {
        printerr(`No hay token guardado para ${url}.`);
        return 1;
    }

    // Sin GLib.MainLoop anidado: girarlo dentro de una función async bloquea las promesas de
    // GJS (el await del cliente no volvería nunca). Una promesa y el bucle implícito de GJS.
    const code = await new Promise<number>(resolve => {
        const client = new HaClient({
            onStatus: (status, detail) => {
                if (status === Status.AUTH_FAILED || status === Status.OFFLINE || status === Status.BAD_URL) {
                    printerr(`No se pudo conectar (${status}): ${detail ?? ''}`);
                    client.destroy();
                    resolve(1);
                }
            },
            onStates: states => {
                report(url, client, states);
                client.destroy();
                resolve(0);
            },
        });
        client.connect(url, token);
    });
    return code;
}

function report(url: string, client: HaClient, states: HaClient['states']): void {
    print(`Home Assistant: ${url}`);
    print(`${states.size} climas\n`);
    for (const [id, state] of states) {
        const c = describeClimate(id, state);
        const features = Number(state.attributes.supported_features ?? 0);
        print(`${id}  «${c.name}»  [${client.registry.get(id)?.platform ?? 'integración desconocida'}]`);
        print(`  ahora:      ${now(c)}`);
        print(`  modos:      ${c.hvacModes.join(', ') || '—'}`);
        print(`  funciones:  ${FEATURE_NAMES.filter(([, bit]) => features & bit).map(([name]) => name).join(', ') || '—'} (${features})`);
        print(`  encender:   ${c.turnOn ?? 'no se puede'} · apagar: ${c.turnOff ?? 'no se puede'}`);
        if (c.target)
            print(`  consigna:   ${c.target.min}–${c.target.max}, paso ${c.target.step}`);
        if (c.fanModes.length)
            print(`  ventilador: ${c.fanModes.join(', ')}`);
        if (c.presetModes.length)
            print(`  preset:     ${c.presetModes.join(', ')}`);
        if (c.swingModes.length)
            print(`  oscilación: ${c.swingModes.join(', ')}`);
        print(`  hvac_action: ${c.reportsAction ? `sí (${c.action})` : 'no'}`);
        // Algunas integraciones dicen cuándo hablaron con la nube por última vez (Koolnova sí).
        if (state.attributes.last_sync !== undefined)
            print(`  última sincronización con la nube: ${state.attributes.last_sync}`);
        print('');
    }

    print('Cómo lo agrupa Alisio:');
    for (const unit of buildHome(states, client.registry).units) {
        if (unit.kind === 'shared') {
            print(`  Sistema con modo compartido (${unit.platform}): máquina ${unit.machine.id} en ${unit.machine.mode}`);
            print(`    zonas: ${unit.zones.map(z => `${z.name}${z.on ? ' (encendida)' : ''}`).join(', ')}`);
            print(`    ventilador calculado de las zonas: ${systemFan(unit) ?? 'mixto'}`);
        } else {
            print(`  Aire suelto: ${unit.climate.name}`);
        }
    }
}

function now(c: Climate): string {
    const parts = [c.available ? c.mode : 'no disponible'];
    if (c.current !== null)
        parts.push(`${c.current} °C`);
    if (c.targetValue !== null)
        parts.push(`consigna ${c.targetValue}`);
    if (c.fan)
        parts.push(`ventilador ${c.fan}`);
    if (c.preset)
        parts.push(`preset ${c.preset}`);
    return parts.join(' · ');
}
