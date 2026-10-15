// La casa: los climas agrupados como funcionan de verdad, y las órdenes que pide cada gesto.
//
// Un sistema por conductos (Koolnova, Airzone…) expone una "máquina" que manda el modo
// (frío/calor para toda la casa) y unas zonas que solo se encienden o se apagan. Alisio
// los agrupa: arriba el modo de la máquina, debajo las zonas. El resto, un aire por clima.
//
// Las órdenes se devuelven como listas de ServiceCall, sin enviarlas: así se prueba
// exactamente qué llega a HA (y, por tanto, cuántas peticiones a la nube del fabricante).

import type {EntityState, RegistryEntry, ServiceCall} from '../ha/protocol.js';
import {describeClimate, snapTarget, type Climate} from './capabilities.js';

export interface SharedSystem {
    kind: 'shared';
    platform: string;
    machine: Climate;
    zones: Climate[];
}

export interface Standalone {
    kind: 'standalone';
    climate: Climate;
}

export type Unit = SharedSystem | Standalone;

export interface Home {
    units: Unit[];
}

const ZONE_MODES = ['auto', 'off'];
const MACHINE_MODES = ['cool', 'heat'];

const byName = (a: Climate, b: Climate) => a.name.localeCompare(b.name, 'es', {numeric: true});

function isZone(c: Climate): boolean {
    return same([...c.hvacModes].sort(), ZONE_MODES);
}

function isMachine(c: Climate): boolean {
    return c.activeModes.some(m => MACHINE_MODES.includes(m));
}

/**
 * Agrupa los climas. Un sistema con modo compartido = misma integración, exactamente un
 * clima con frío/calor y al menos dos que solo admiten apagado/auto. Sin registro (no se
 * sabe la integración) no se agrupa nada: mejor separados que mal juntados.
 */
export function buildHome(states: ReadonlyMap<string, EntityState>,
    registry: ReadonlyMap<string, RegistryEntry>): Home {
    const climates = [...states.entries()]
        .filter(([id]) => id.startsWith('climate.'))
        .map(([id, state]) => describeClimate(id, state));

    const byPlatform = new Map<string, Climate[]>();
    for (const c of climates) {
        const platform = registry.get(c.id)?.platform;
        if (platform)
            byPlatform.set(platform, [...byPlatform.get(platform) ?? [], c]);
    }

    const grouped = new Set<string>();
    const systems: SharedSystem[] = [];
    for (const [platform, members] of byPlatform) {
        const zones = members.filter(isZone);
        const machines = members.filter(c => !isZone(c) && isMachine(c));
        if (machines.length !== 1 || zones.length < 2)
            continue;
        systems.push({kind: 'shared', platform, machine: machines[0], zones: zones.sort(byName)});
        [machines[0], ...zones].forEach(c => grouped.add(c.id));
    }

    const standalone: Standalone[] = climates.filter(c => !grouped.has(c.id)).sort(byName)
        .map(climate => ({kind: 'standalone', climate}));
    return {units: [...systems, ...standalone]};
}

/** Todas las cosas que se encienden: zonas de los sistemas y aires sueltos. */
export function switchables(home: Home): Climate[] {
    return home.units.flatMap(u => u.kind === 'shared' ? u.zones : [u.climate]);
}

/**
 * El ventilador de un sistema, calculado a partir de sus zonas (el atributo de la máquina
 * guarda lo último pedido desde HA, no lo real). `null` si las zonas no coinciden.
 */
export function systemFan(system: SharedSystem): string | null {
    const fans = new Set(system.zones.map(z => z.fan));
    return fans.size === 1 ? [...fans][0] : null;
}

// --- Memoria del último modo -------------------------------------------------

/**
 * Para encender un aire sin orden `turn_on` hay que elegir un modo: el último que tuvo
 * encendido. Se aprende observando los estados; sin historia, el más neutro que admita.
 */
export class ModeMemory {
    private readonly _last = new Map<string, string>();

    observe(climates: Climate[]): void {
        for (const c of climates) {
            if (c.on && c.activeModes.includes(c.mode))
                this._last.set(c.id, c.mode);
        }
    }

    modeToTurnOn(c: Climate): string | null {
        const remembered = this._last.get(c.id);
        if (remembered && c.activeModes.includes(remembered))
            return remembered;
        return ['auto', 'heat_cool', 'cool', 'heat'].find(m => c.activeModes.includes(m)) ?? c.activeModes[0] ?? null;
    }
}

// --- Órdenes -----------------------------------------------------------------

const call = (service: string, id: string, data?: Record<string, unknown>): ServiceCall =>
    ({domain: 'climate', service, target: {entity_id: [id]}, ...(data ? {data} : {})});

/** Encender o apagar. `null` si ya está así o si el aparato no lo permite. */
export function setPower(c: Climate, on: boolean, memory: ModeMemory): ServiceCall | null {
    if (!c.available || c.on === on)
        return null;
    const how = on ? c.turnOn : c.turnOff;
    if (how === 'service')
        return call(on ? 'turn_on' : 'turn_off', c.id);
    if (how === 'mode') {
        const mode = on ? memory.modeToTurnOn(c) : 'off';
        return mode ? call('set_hvac_mode', c.id, {hvac_mode: mode}) : null;
    }
    return null;
}

/** Nueva consigna, ajustada al paso y los límites. `null` si no cambia nada. */
export function setTarget(c: Climate, value: number): ServiceCall | null {
    if (!c.available || !c.target)
        return null;
    const temperature = snapTarget(value, c.target);
    return temperature === c.targetValue ? null : call('set_temperature', c.id, {temperature});
}

export function setFan(c: Climate, fan: string): ServiceCall | null {
    if (!c.available || !c.fanModes.includes(fan) || c.fan === fan)
        return null;
    return call('set_fan_mode', c.id, {fan_mode: fan});
}

/** Frío / calor de un sistema compartido: una sola orden, a la máquina. */
export function setSystemMode(system: SharedSystem, mode: string): ServiceCall | null {
    const {machine} = system;
    if (!machine.available || !machine.hvacModes.includes(mode) || machine.mode === mode)
        return null;
    return call('set_hvac_mode', machine.id, {hvac_mode: mode});
}

/** "Apagar todo": solo a lo que está encendido, una orden por zona (salen en ola). */
export function allOff(home: Home, memory: ModeMemory): ServiceCall[] {
    return switchables(home)
        .map(c => setPower(c, false, memory))
        .filter((c): c is ServiceCall => c !== null);
}

function same(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
