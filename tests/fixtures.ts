// La casa de Julio tal como la publica HA (atributos verificados el 2026-10-15), más un
// split independiente de otra marca para probar el camino "un aire, un clima".

import {Feature} from '../src/model/capabilities.js';
import {KoolnovaCloud, type MockState} from './mockHa.js';

export const MACHINE = 'climate.koolnova_control_global';
export const ZONE_IDS = [1, 2, 3, 4, 5].map(n => `climate.koolnova_thermostat_${n}`);
export const [DORMITORIO, INVITADOS, SALON, DESPACHO, COCINA] = ZONE_IDS;
export const SPLIT = 'climate.split_estudio';

const ZONE_NAMES = ['Dormitorio', 'Invitados', 'Salón', 'Despacho', 'Cocina'];
const FAN_MODES = ['low', 'medium', 'high', 'auto'];

export function koolnovaZone(name: string, current: number, target: number, on = false): MockState {
    return {
        s: on ? 'auto' : 'off',
        a: {
            friendly_name: name,
            hvac_modes: ['off', 'auto'],
            min_temp: 16,
            max_temp: 27,
            target_temp_step: 0.5,
            fan_modes: FAN_MODES,
            current_temperature: current,
            temperature: target,
            fan_mode: 'medium',
            supported_features: Feature.TARGET_TEMPERATURE | Feature.FAN_MODE,
        },
    };
}

export function koolnovaHouse({on = [] as string[], mode = 'cool'} = {}) {
    const states: Record<string, MockState> = {
        [MACHINE]: {
            s: mode,
            a: {
                friendly_name: 'Koolnova',
                hvac_modes: ['cool', 'heat'],
                min_temp: 16,
                max_temp: 27,
                target_temp_step: 0.5,
                fan_modes: FAN_MODES,
                preset_modes: ['off', 'auto'],
                // Poco fiables a propósito: lo último pedido desde HA, no lo real.
                fan_mode: 'auto',
                preset_mode: 'auto',
                temperature: 24,
                supported_features: Feature.TARGET_TEMPERATURE | Feature.FAN_MODE | Feature.PRESET_MODE,
            },
        },
        'light.salon': {s: 'on', a: {friendly_name: 'Luz salón'}},
        'sensor.temperatura_salon': {s: '24.5', a: {unit_of_measurement: '°C'}},
    };
    const currents = [23.5, 25, 26, 24.5, 27];
    ZONE_IDS.forEach((id, i) => {
        states[id] = koolnovaZone(ZONE_NAMES[i], currents[i], 23, on.includes(id));
    });
    const platforms = Object.fromEntries([MACHINE, ...ZONE_IDS].map(id => [id, 'koolnova']));
    return {states, platforms, cloud: new KoolnovaCloud(MACHINE, ZONE_IDS)};
}

export const splitState: MockState = {
    s: 'off',
    a: {
        friendly_name: 'Estudio',
        hvac_modes: ['off', 'cool', 'heat', 'dry', 'fan_only', 'heat_cool'],
        min_temp: 18,
        max_temp: 30,
        target_temp_step: 1,
        fan_modes: ['auto', 'silence', '1', '2', '3'],
        swing_modes: ['off', 'vertical'],
        current_temperature: 22,
        current_humidity: 48,
        temperature: 24,
        fan_mode: 'auto',
        swing_mode: 'off',
        hvac_action: 'off',
        supported_features: Feature.TARGET_TEMPERATURE | Feature.FAN_MODE | Feature.SWING_MODE
            | Feature.TURN_ON | Feature.TURN_OFF,
    },
};
