// Qué sabe hacer un clima y cómo está ahora, leído de lo que publica Home Assistant.
// Alisio no supone nada: cada control de la ventana sale de aquí.

import type {EntityState} from '../ha/protocol.js';

/** `ClimateEntityFeature` de Home Assistant. */
export const Feature = Object.freeze({
    TARGET_TEMPERATURE: 1,
    TARGET_TEMPERATURE_RANGE: 2,
    TARGET_HUMIDITY: 4,
    FAN_MODE: 8,
    PRESET_MODE: 16,
    SWING_MODE: 32,
    TURN_OFF: 128,
    TURN_ON: 256,
});

// Lo que usa HA cuando el clima no publica sus límites (en °C).
const DEFAULT_MIN = 7;
const DEFAULT_MAX = 35;
const DEFAULT_STEP = 0.5;

export interface TargetRange {
    min: number;
    max: number;
    step: number;
}

export interface Climate {
    id: string;
    name: string;
    available: boolean;

    // Lo que admite
    hvacModes: string[];
    /** Los modos que significan "encendido" (todos menos `off`). */
    activeModes: string[];
    /** Encender o apagar con su orden propia (`turn_on`/`turn_off`) o eligiendo un modo. */
    turnOn: 'service' | 'mode' | null;
    turnOff: 'service' | 'mode' | null;
    target: TargetRange | null;
    targetBand: boolean;
    fanModes: string[];
    presetModes: string[];
    swingModes: string[];
    /** Si publica `hvac_action` ("enfriando", "en espera"…). Si no, solo se dice "encendida". */
    reportsAction: boolean;

    // Cómo está
    mode: string;
    on: boolean;
    current: number | null;
    humidity: number | null;
    targetValue: number | null;
    fan: string | null;
    preset: string | null;
    action: string | null;
}

const UNAVAILABLE = new Set(['unavailable', 'unknown']);

export function describeClimate(id: string, {state, attributes: a}: EntityState): Climate {
    const features = num(a.supported_features) ?? 0;
    const has = (flag: number) => (features & flag) !== 0;
    const hvacModes = strings(a.hvac_modes);
    const activeModes = hvacModes.filter(m => m !== 'off');
    const available = !UNAVAILABLE.has(state);

    const turnOn = has(Feature.TURN_ON) ? 'service' : activeModes.length ? 'mode' : null;
    const turnOff = has(Feature.TURN_OFF) ? 'service' : hvacModes.includes('off') ? 'mode' : null;

    return {
        id,
        name: typeof a.friendly_name === 'string' && a.friendly_name ? a.friendly_name : id,
        available,
        hvacModes,
        activeModes,
        turnOn,
        turnOff,
        target: has(Feature.TARGET_TEMPERATURE) ? {
            min: num(a.min_temp) ?? DEFAULT_MIN,
            max: num(a.max_temp) ?? DEFAULT_MAX,
            step: num(a.target_temp_step) ?? DEFAULT_STEP,
        } : null,
        targetBand: has(Feature.TARGET_TEMPERATURE_RANGE),
        fanModes: has(Feature.FAN_MODE) ? strings(a.fan_modes) : [],
        presetModes: has(Feature.PRESET_MODE) ? strings(a.preset_modes) : [],
        swingModes: has(Feature.SWING_MODE) ? strings(a.swing_modes) : [],
        reportsAction: 'hvac_action' in a,

        mode: state,
        on: available && state !== 'off',
        current: num(a.current_temperature),
        humidity: num(a.current_humidity),
        targetValue: num(a.temperature),
        fan: typeof a.fan_mode === 'string' ? a.fan_mode : null,
        preset: typeof a.preset_mode === 'string' ? a.preset_mode : null,
        action: typeof a.hvac_action === 'string' ? a.hvac_action : null,
    };
}

/** Ajusta una consigna a los límites y al paso del aparato. */
export function snapTarget(value: number, {min, max, step}: TargetRange): number {
    const snapped = Math.round((value - min) / step) * step + min;
    // Redondeo a 2 decimales: 0,1 + 0,2 no debe acabar mandando 23.000000000000004.
    return Math.round(Math.min(max, Math.max(min, snapped)) * 100) / 100;
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
