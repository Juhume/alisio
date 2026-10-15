// Qué deduce Alisio de cada clima. Sin red: funciones puras.

import {describeClimate, snapTarget} from '../src/model/capabilities.js';
import {Optimistic} from '../src/model/optimistic.js';
import {check, run, same, section} from './harness.js';
import {koolnovaHouse, splitState, MACHINE, DESPACHO} from './fixtures.js';

const {states} = koolnovaHouse();
const asEntity = ({s, a}: {s: string; a: Record<string, unknown>}) => ({state: s, attributes: a});

function testKoolnovaZone() {
    section('Zona Koolnova');
    const z = describeClimate(DESPACHO, asEntity(states[DESPACHO]));
    check(z.name === 'Despacho', 'nombre de friendly_name');
    check(same(z.activeModes, ['auto']), 'solo "auto" cuenta como encendida');
    check(z.turnOn === 'mode' && z.turnOff === 'mode', 'sin turn_on/turn_off: se enciende eligiendo modo');
    check(same(z.target, {min: 16, max: 27, step: 0.5}), 'consigna 16–27 en pasos de 0,5');
    check(same(z.fanModes, ['low', 'medium', 'high', 'auto']), 'ventilador de 4 velocidades');
    check(z.presetModes.length === 0 && z.swingModes.length === 0, 'sin preset ni oscilación');
    check(!z.reportsAction && z.action === null, 'no publica hvac_action → nunca "enfriando"');
    check(!z.on && z.current === 24.5 && z.targetValue === 23, 'lectura: apagada, 24,5 °C, consigna 23');
}

function testKoolnovaMachine() {
    section('Máquina Koolnova');
    const m = describeClimate(MACHINE, asEntity(states[MACHINE]));
    check(same(m.activeModes, ['cool', 'heat']), 'frío y calor');
    check(m.turnOff === null, 'no se puede apagar: no tiene "off"');
    check(m.on && m.mode === 'cool', 'en frío cuenta como encendida');
    check(same(m.presetModes, ['off', 'auto']), 'preset = modo de zonas');
}

function testSplit() {
    section('Split con todo');
    const s = describeClimate('climate.split_estudio', asEntity(splitState));
    check(s.turnOn === 'service' && s.turnOff === 'service', 'usa sus órdenes propias de encender y apagar');
    check(s.reportsAction, 'publica hvac_action');
    check(same(s.target, {min: 18, max: 30, step: 1}), 'límites y paso propios');
    check(s.humidity === 48, 'humedad actual');
    check(same(s.swingModes, ['off', 'vertical']), 'oscilación');
}

function testOddities() {
    section('Climas raros');
    const bare = describeClimate('climate.x', {state: 'heat', attributes: {supported_features: 1}});
    check(bare.name === 'climate.x', 'sin friendly_name → el entity_id');
    check(same(bare.target, {min: 7, max: 35, step: 0.5}), 'sin límites → los de HA');
    check(bare.turnOn === null && bare.turnOff === null, 'sin modos ni órdenes → no se enciende ni apaga');
    const gone = describeClimate(DESPACHO, {state: 'unavailable', attributes: states[DESPACHO].a});
    check(!gone.available && !gone.on, '"unavailable" → no disponible y no encendida');
    const fanless = describeClimate('climate.y', {state: 'off', attributes: {fan_modes: ['low'], supported_features: 0}});
    check(fanless.fanModes.length === 0, 'fan_modes sin el bit FAN_MODE se ignora');
    const junk = describeClimate('climate.z', {state: 'off', attributes: {hvac_modes: 'cool', current_temperature: 'NaN'}});
    check(junk.hvacModes.length === 0 && junk.current === null, 'atributos con tipos raros no rompen nada');
}

function testSnap() {
    section('Ajuste de consigna');
    const range = {min: 16, max: 27, step: 0.5};
    check(snapTarget(23.3, range) === 23.5, '23,3 → 23,5');
    check(snapTarget(23.2, range) === 23, '23,2 → 23');
    check(snapTarget(40, range) === 27 && snapTarget(3, range) === 16, 'recorta a los límites');
    check(snapTarget(0.1 + 0.2 + 22.7, {min: 7, max: 35, step: 0.1}) === 23, 'sin decimales basura');
}

function testOptimistic() {
    section('Optimista');
    let now = 0;
    const o = new Optimistic(() => now);
    const real = describeClimate(DESPACHO, asEntity(states[DESPACHO]));

    o.expect(DESPACHO, 'on', true);
    check(o.apply(real).on && o.isPending(DESPACHO), 'muestra lo pedido y marca "en curso"');
    now = 10_000;
    check(o.apply(real).on, 'sin confirmar, aguanta más que el plazo del cliente');
    o.confirmed(DESPACHO, 'on');
    now = 14_000;
    check(o.apply(real).on, 'confirmada: aguanta 5 s esperando al estado');
    now = 15_001;
    check(!o.apply(real).on && !o.isPending(DESPACHO), 'pasados 5 s sin cambio, manda lo real');
    check(JSON.stringify(o.takeUnfulfilled()) === JSON.stringify([{id: DESPACHO, field: 'on'}]),
        'y la apunta como incumplida (el aparato no respondió)');
    check(o.takeUnfulfilled().length === 0, 'se avisa una sola vez');

    o.expect(DESPACHO, 'on', true);
    const nowOn = {...real, on: true, mode: 'auto'};
    check(o.apply(nowOn).on && !o.isPending(DESPACHO), 'cuando lo real coincide, se retira');

    o.expect(DESPACHO, 'targetValue', 24);
    o.cancel(DESPACHO, 'targetValue');
    check(o.apply(real).targetValue === 23, 'si HA la rechaza, vuelve lo real al momento');

    o.expect(DESPACHO, 'fan', 'low');
    now += 26_000;
    o.apply(real);
    check(o.takeUnfulfilled().length === 0, 'sin confirmar no es "no respondió" (ya avisó el error)');

    now = 0;
    o.expect(DESPACHO, 'fan', 'low');
    check(o.nextDeadline() === 25_000, 'sabe cuándo repintar');
}

run([testKoolnovaZone, testKoolnovaMachine, testSplit, testOddities, testSnap, testOptimistic]);
