// Textos de modos, velocidades y cifras. Breves y directos; HA da claves en inglés.

import Gettext from 'gettext';

export const _ = (text: string) => Gettext.gettext(text);

const MODES: Record<string, string> = {
    off: 'Apagado',
    cool: 'Frío',
    heat: 'Calor',
    auto: 'Automático',
    heat_cool: 'Frío y calor',
    dry: 'Seco',
    fan_only: 'Ventilador',
};

const FANS: Record<string, string> = {
    low: 'Bajo',
    medium: 'Medio',
    middle: 'Medio',
    high: 'Alto',
    auto: 'Automático',
    quiet: 'Silencio',
    silence: 'Silencio',
    turbo: 'Turbo',
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

export const modeLabel = (mode: string) => MODES[mode] ? _(MODES[mode]) : capitalize(mode);
export const fanLabel = (fan: string) => FANS[fan] ? _(FANS[fan]) : capitalize(fan);

const decimal = new Intl.NumberFormat(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 1});

/** 24.5 → "24,5 °C" (con el separador del idioma del sistema). */
export const degrees = (value: number) => `${decimal.format(value)} °C`;
export const number = (value: number) => decimal.format(value);
