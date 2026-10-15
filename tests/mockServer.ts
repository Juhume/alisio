// npm run mock — la casa simulada, escuchando en http://127.0.0.1:8124, para probar la
// ventana sin acercarse a la nube de Koolnova. Token: «buen-token».
// Cada orden se imprime con la cuenta de peticiones que habría costado de verdad.

import GLib from 'gi://GLib';

import {MockHa} from './mockHa.js';
import {DESPACHO, SALON, SPLIT, koolnovaHouse, splitState} from './fixtures.js';

const port = Number(GLib.getenv('ALISIO_MOCK_PORT') ?? 8124);
const withSplit = GLib.getenv('ALISIO_MOCK_SPLIT') === '1';
const {states, platforms, cloud} = koolnovaHouse({on: [SALON]});
const ha = new MockHa({
    port,
    states: withSplit ? {...states, [SPLIT]: splitState} : states,
    platforms,
    cloud,
});

print(`HA simulado en ${ha.url} · token «${ha.token}»${withSplit ? ' · con split' : ''}`);
print('Ctrl+C para parar.\n');

let logged = 0;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    for (; logged < ha.calls.length; logged++) {
        const c = ha.calls[logged];
        print(`→ ${c.domain}.${c.service} ${c.entity_id.join(', ')} ${JSON.stringify(c.data)}` +
            `   (nube: ${cloud.requests} peticiones${cloud.blocked ? ', BLOQUEADA' : ''})`);
    }
    return GLib.SOURCE_CONTINUE;
});

// La temperatura del despacho baila un poco, como en una casa de verdad.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
    const current = Number(ha.states[DESPACHO].a.current_temperature);
    ha.setAttributes(DESPACHO, {current_temperature: current >= 25 ? 24 : current + 0.5});
    return GLib.SOURCE_CONTINUE;
});

new GLib.MainLoop(null, false).run();
