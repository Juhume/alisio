// La casa agrupada y las órdenes que produce cada gesto. La última parte manda esas órdenes
// de verdad al HA simulado y cuenta las peticiones que acabarían en la nube de Koolnova.

import type {EntityState, RegistryEntry, ServiceCall} from '../src/ha/protocol.js';
import {HaClient, Status} from '../src/ha/client.js';
import {
    ModeMemory, allOff, buildHome, setFan, setPower, setSystemMode, setTarget, switchables, systemFan,
    type SharedSystem,
} from '../src/model/home.js';
import {check, run, same, section, until} from './harness.js';
import {COCINA, DESPACHO, MACHINE, SALON, SPLIT, ZONE_IDS, koolnovaHouse, splitState} from './fixtures.js';
import {MockHa, type MockState} from './mockHa.js';

function maps(states: Record<string, MockState>, platforms: Record<string, string>) {
    const s = new Map<string, EntityState>(Object.entries(states).map(([id, {s, a}]) => [id, {state: s, attributes: a}]));
    const r = new Map<string, RegistryEntry>(Object.keys(states)
        .map(id => [id, {platform: platforms[id] ?? null, deviceId: null, areaId: null}]));
    return [s, r] as const;
}

function testGrouping() {
    section('Agrupar la casa');
    const {states, platforms} = koolnovaHouse();
    const home = buildHome(...maps({...states, [SPLIT]: splitState}, platforms));
    check(home.units.length === 2, 'un sistema y un aire suelto');
    const system = home.units[0] as SharedSystem;
    check(system.kind === 'shared' && system.machine.id === MACHINE, 'la máquina manda el modo');
    check(same(system.zones.map(z => z.name), ['Cocina', 'Despacho', 'Dormitorio', 'Invitados', 'Salón']),
        'cinco zonas, por nombre');
    check(home.units[1].kind === 'standalone', 'el split va aparte');
    check(switchables(home).length === 6, 'seis cosas que se encienden');
    check(!switchables(home).some(c => c.id === MACHINE), 'la máquina no es una zona');

    const noRegistry = buildHome(maps(states, platforms)[0], new Map());
    check(noRegistry.units.every(u => u.kind === 'standalone'), 'sin registro no se agrupa nada');

    const mixed = buildHome(...maps(states, {...platforms, [MACHINE]: 'otra'}));
    check(mixed.units.every(u => u.kind === 'standalone'), 'integraciones distintas no se agrupan');

    const oneZone = Object.fromEntries(Object.entries(states).filter(([id]) => ![SALON, COCINA, ...ZONE_IDS.slice(0, 3)].includes(id)));
    check(buildHome(...maps(oneZone, platforms)).units.every(u => u.kind === 'standalone'),
        'una sola zona no forma sistema');
}

function testDerived() {
    section('Valores calculados');
    const {states, platforms} = koolnovaHouse();
    const system = buildHome(...maps(states, platforms)).units[0] as SharedSystem;
    check(systemFan(system) === 'medium', 'ventilador de las zonas, no el "auto" de la máquina');
    states[SALON].a.fan_mode = 'high';
    const mixed = buildHome(...maps(states, platforms)).units[0] as SharedSystem;
    check(systemFan(mixed) === null, 'zonas con velocidades distintas → mixto');
}

function testCommands() {
    section('Órdenes');
    const {states, platforms} = koolnovaHouse({on: [SALON]});
    const home = buildHome(...maps({...states, [SPLIT]: splitState}, platforms));
    const system = home.units[0] as SharedSystem;
    const zone = (id: string) => system.zones.find(z => z.id === id)!;
    const split = switchables(home).find(c => c.id === SPLIT)!;
    const memory = new ModeMemory();

    check(same(setPower(zone(DESPACHO), true, memory),
        {domain: 'climate', service: 'set_hvac_mode', target: {entity_id: [DESPACHO]}, data: {hvac_mode: 'auto'}}),
    'encender zona = set_hvac_mode auto');
    check(same(setPower(zone(SALON), false, memory)?.data, {hvac_mode: 'off'}), 'apagar zona = set_hvac_mode off');
    check(setPower(zone(SALON), true, memory) === null, 'encender lo encendido = nada');
    check(setPower(split, true, memory)?.service === 'turn_on', 'el split usa turn_on');

    memory.observe([{...split, on: true, mode: 'heat'}]);
    const noTurnOn = {...split, turnOn: 'mode' as const};
    check(setPower(noTurnOn, true, memory)?.data?.hvac_mode === 'heat', 'sin turn_on, vuelve al último modo usado');
    check(setPower({...noTurnOn, id: 'climate.nuevo'}, true, memory)?.data?.hvac_mode === 'heat_cool',
        'sin historia, el modo más neutro que admita');

    check(same(setTarget(zone(DESPACHO), 23.3)?.data, {temperature: 23.5}), 'consigna ajustada al paso');
    check(setTarget(zone(DESPACHO), 23.1) === null, 'consigna que redondea a la actual = nada');
    check(same(setFan(zone(DESPACHO), 'low')?.data, {fan_mode: 'low'}), 'ventilador');
    check(setFan(zone(DESPACHO), 'turbo') === null && setFan(zone(DESPACHO), 'medium') === null,
        'velocidad inexistente o igual = nada');

    check(same(setSystemMode(system, 'heat'), {domain: 'climate', service: 'set_hvac_mode',
        target: {entity_id: [MACHINE]}, data: {hvac_mode: 'heat'}}), 'calor = una orden a la máquina');
    check(setSystemMode(system, 'cool') === null && setSystemMode(system, 'dry') === null,
        'modo igual o inexistente = nada');

    const gone = {...zone(DESPACHO), available: false};
    check(setPower(gone, true, memory) === null && setTarget(gone, 25) === null, 'no disponible = nada');
}

async function testCloudBudget() {
    section('Peticiones reales a la nube (Koolnova simulado)');
    const {states, platforms, cloud} = koolnovaHouse({on: [SALON, COCINA]});
    const ha = new MockHa({states, platforms, cloud});
    const client = new HaClient();
    client.connect(ha.url, 'buen-token');
    await until(() => client.status === Status.CONNECTED);
    const home = () => buildHome(client.states, client.registry);
    const send = (calls: (ServiceCall | null)[]) =>
        Promise.all(calls.filter((c): c is ServiceCall => c !== null).map(c => client.callService(c)));
    const memory = new ModeMemory();

    check(cloud.requests === 0, 'conectar y leer: 0 peticiones');

    await send(allOff(home(), memory));
    check(cloud.requests === 2, '"Apagar todo" con 2 zonas encendidas = 2 peticiones');
    await until(() => switchables(home()).every(c => !c.on));
    await send(allOff(home(), memory));
    check(cloud.requests === 2, '"Apagar todo" con todo apagado = 0 peticiones');

    const system = () => home().units[0] as SharedSystem;
    await send([setSystemMode(system(), 'heat')]);
    check(cloud.requests === 3, 'pasar a calor = 1 petición');
    check(await until(() => system().machine.mode === 'heat'), 'y la máquina queda en calor');

    const despacho = () => system().zones.find(z => z.id === DESPACHO)!;
    await send([setPower(despacho(), true, memory)]);
    await send([setTarget(despacho(), 24)]);
    await send([setFan(despacho(), 'low')]);
    check(cloud.requests === 6, 'encender, consigna y ventilador de una zona = 3 peticiones');
    check(await until(() => despacho().on && despacho().targetValue === 24 && despacho().fan === 'low'),
        'el despacho refleja los tres cambios');
    check(ha.received.get_states === 1 && ha.received.subscribe_entities === 1, 'ni un sondeo: una lectura y luego todo llega empujado');
    check(!cloud.blocked, 'Koolnova no bloquea');

    client.destroy();
    ha.stop();
}

async function testCloudBlock() {
    section('El simulador bloquea como la nube real');
    const {states, platforms, cloud} = koolnovaHouse();
    const ha = new MockHa({states, platforms, cloud});
    const client = new HaClient();
    client.connect(ha.url, 'buen-token');
    await until(() => client.status === Status.CONNECTED);
    let error: Error | null = null;
    for (let i = 0; i < 3 && !error; i++) {
        // La consigna de la máquina se repite en las 5 zonas: 5 peticiones cada vez.
        await client.callService({domain: 'climate', service: 'set_temperature',
            target: {entity_id: [MACHINE]}, data: {temperature: 22 + i}}).catch(e => (error = e));
    }
    check(cloud.blocked && (error as Error | null)?.message.includes('bloqueada') === true,
        '15 peticiones en un minuto → bloqueo (por eso Alisio nunca envía la consigna "global")');
    client.destroy();
    ha.stop();
}

run([testGrouping, testDerived, testCommands, testCloudBudget, testCloudBlock]);
