// gjs -m build/tests/client.test.js (o npm test)
// Ejercita HaClient de punta a punta contra MockHa, en el mismo bucle de eventos.

import {HaClient, Status, websocketUrl} from '../src/ha/client.js';
import {check, run, section, same, sleep, until} from './harness.js';
import {DESPACHO, MACHINE, SPLIT, ZONE_IDS, koolnovaHouse, splitState} from './fixtures.js';
import {MockHa} from './mockHa.js';

function makeClient() {
    const log: [Status, string | null][] = [];
    let statesSeen = 0;
    const client = new HaClient({
        onStatus: (status, detail) => log.push([status, detail]),
        onStates: () => statesSeen++,
    });
    return {client, log, states: () => statesSeen};
}

function house(options = {}) {
    const {states, platforms, cloud} = koolnovaHouse();
    return new MockHa({states: {...states, [SPLIT]: splitState}, platforms, cloud, ...options});
}

function testUrls() {
    section('websocketUrl');
    check(websocketUrl('https://casa.example.ts.net:8445/') ===
        'wss://casa.example.ts.net:8445/api/websocket', 'https → wss y quita la barra final');
    check(websocketUrl('http://192.168.1.10:8123') === 'ws://192.168.1.10:8123/api/websocket', 'http → ws');
    check(websocketUrl('casa:8445') === null, 'sin esquema → null');
    check(websocketUrl('https://host/ruta') === null, 'con ruta → null');
}

async function testHappyPath() {
    section('Conecta, descubre los climas y recibe cambios');
    const ha = house();
    const {client, log} = makeClient();
    client.connect(ha.url, 'buen-token');

    check(await until(() => client.status === Status.CONNECTED), 'llega a CONNECTED');
    check(log[0][0] === Status.CONNECTING, 'pasa antes por CONNECTING');
    check(client.states.size === 7, 'se suscribe a los 7 climas');
    check(!client.states.has('light.salon') && !client.states.has('sensor.temperatura_salon'),
        'solo climas: ni luces ni sensores');
    check(client.states.get(DESPACHO)?.state === 'off', 'estado inicial del despacho');
    check(client.states.get(DESPACHO)?.attributes.current_temperature === 24.5, 'atributos iniciales');
    check(client.registry.get(MACHINE)?.platform === 'koolnova', 'registro: integración de la máquina');
    check(client.registry.get(SPLIT)?.platform === null, 'registro: sin integración conocida → null');
    check(ha.received.subscribe_entities === 1 && ha.received.get_states === 1, 'una lectura y una suscripción');

    ha.setAttributes(DESPACHO, {current_temperature: 24});
    check(await until(() => client.states.get(DESPACHO)!.attributes.current_temperature === 24), 'aplica la diferencia');
    check(client.states.get(DESPACHO)!.attributes.fan_mode === 'medium', 'conserva atributos al aplicar diferencias');

    await client.callService({domain: 'climate', service: 'set_hvac_mode', target: {entity_id: [DESPACHO]},
        data: {hvac_mode: 'auto'}});
    check(same(ha.calls.at(-1), {domain: 'climate', service: 'set_hvac_mode', entity_id: [DESPACHO],
        data: {hvac_mode: 'auto'}}), 'call_service llega con sus datos');
    check(await until(() => client.states.get(DESPACHO)!.state === 'auto'), 'el estado se actualiza tras la llamada');
    check(ha.cloud!.requests === 1, 'una orden = una petición a Koolnova');

    client.destroy();
    ha.stop();
}

async function testCommand() {
    section('Peticiones genéricas');
    const ha = house();
    const {client} = makeClient();
    client.connect(ha.url, 'buen-token');
    await until(() => client.status === Status.CONNECTED);
    const states = await client.command<{entity_id: string}[]>({type: 'get_states'});
    check(states.length === 9, 'command devuelve el result de HA');
    let error: Error | null = null;
    await client.command({type: 'no/existe'}).catch(e => (error = e));
    check(error !== null && (error as Error).message === 'Unknown command.', 'command rechaza con el mensaje de HA');
    client.destroy();
    ha.stop();
}

async function testNoRegistry() {
    section('HA sin registro de entidades');
    const ha = house({noRegistry: true});
    const {client} = makeClient();
    client.connect(ha.url, 'buen-token');
    check(await until(() => client.status === Status.CONNECTED), 'conecta igual');
    check(client.registry.size === 0 && client.states.size === 7, 'registro vacío, climas presentes');
    client.destroy();
    ha.stop();
}

async function testNoClimates() {
    section('Casa sin aires');
    const ha = new MockHa({states: {'light.salon': {s: 'on', a: {}}}});
    const {client, states} = makeClient();
    client.connect(ha.url, 'buen-token');
    check(await until(() => client.status === Status.CONNECTED), 'conecta');
    check(client.states.size === 0 && states() === 1, 'avisa con la casa vacía');
    check(!ha.received.subscribe_entities, 'no se suscribe a todo con una lista vacía');
    client.destroy();
    ha.stop();
}

async function testAuthFailed() {
    section('Token malo');
    const ha = house();
    const {client} = makeClient();
    client.connect(ha.url, 'token-falso');
    check(await until(() => client.status === Status.AUTH_FAILED), 'queda en AUTH_FAILED');
    await sleep(1500);
    check(client.status === Status.AUTH_FAILED, 'no reintenta con un token rechazado');
    client.destroy();
    ha.stop();
}

function testNoTokenAndBadUrl() {
    section('Configuración incompleta');
    const {client} = makeClient();
    client.connect('https://casa.example.ts.net:8445', '');
    check(client.status === Status.NO_TOKEN, 'sin token → NO_TOKEN');
    client.connect('esto no es una url', 'x');
    check(client.status === Status.BAD_URL, 'URL rota → BAD_URL');
    client.destroy();
}

async function testServiceError() {
    section('El servicio falla');
    const ha = house({failServices: true});
    const {client} = makeClient();
    client.connect(ha.url, 'buen-token');
    await until(() => client.status === Status.CONNECTED);
    let error: Error | null = null;
    await client.callService({domain: 'climate', service: 'set_hvac_mode', target: {entity_id: [DESPACHO]},
        data: {hvac_mode: 'auto'}}).catch(e => (error = e));
    check((error as Error | null)?.message === 'Koolnova dijo que no', 'rechaza con el mensaje de HA');
    check(client.status === Status.CONNECTED, 'un error de servicio no tira la conexión');
    client.destroy();
    ha.stop();
}

async function testReconnect() {
    section('Se cae y vuelve');
    const ha = house();
    const {client, log} = makeClient();
    client.connect(ha.url, 'buen-token');
    await until(() => client.status === Status.CONNECTED);

    ha.dropAll();
    check(await until(() => client.status === Status.OFFLINE), 'detecta el cierre → OFFLINE');
    check(client.retryDelay === 1, 'primer reintento en 1 s');
    check(await until(() => client.status === Status.CONNECTED, 5000), 'reconecta solo');
    check(log.filter(([s]) => s === Status.CONNECTED).length === 2, 'dos conexiones en el registro');
    check(client.states.size === 7 && client.registry.size === 7, 'vuelve con estados y registro completos');

    // Un clima que desaparece mientras no hay conexión no se queda como fantasma.
    delete ha.states[SPLIT];
    ha.dropAll();
    await until(() => client.status === Status.OFFLINE);
    check(await until(() => client.status === Status.CONNECTED, 5000) && !client.states.has(SPLIT),
        'al reconectar, la foto nueva sustituye a la vieja');

    // Mientras está caído, las llamadas fallan rápido en vez de colgarse.
    ha.stop();
    ha.dropAll();
    await until(() => client.status !== Status.CONNECTED);
    let error: Error | null = null;
    await client.callService({domain: 'climate', service: 'set_hvac_mode', target: {entity_id: ZONE_IDS},
        data: {hvac_mode: 'off'}}).catch(e => (error = e));
    check(error !== null, 'callService sin conexión rechaza al instante');
    check(ha.calls.length === 0, 'y no llega nada a HA');

    client.destroy();
}

async function testUnreachable() {
    section('Servidor inexistente');
    const {client, log} = makeClient();
    client.connect('http://127.0.0.1:9', 'x');
    check(await until(() => client.status === Status.OFFLINE), 'queda OFFLINE');
    check(log.at(-1)![1] !== null, `con motivo: «${log.at(-1)![1]}»`);
    client.kick();
    check(client.status === Status.CONNECTING, 'kick() reintenta en el acto');
    client.destroy();
}

async function testReconnectWhileConnecting() {
    section('Conectar dos veces seguidas');
    const ha = house();
    const {client} = makeClient();
    client.connect(ha.url, 'buen-token');
    client.connect(ha.url, 'buen-token');
    check(await until(() => client.status === Status.CONNECTED), 'conecta');
    await sleep(300);
    check(ha.clientCount === 1, 'la primera conexión no queda viva (generación)');
    client.destroy();
    ha.stop();
}

run([
    testUrls, testHappyPath, testCommand, testNoRegistry, testNoClimates, testAuthFailed,
    testNoTokenAndBadUrl, testServiceError, testReconnect, testUnreachable, testReconnectWhileConnecting,
]);
