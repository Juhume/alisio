// Formas de los datos que viajan por la API WebSocket de Home Assistant.

export type Attributes = Record<string, unknown>;

export interface EntityState {
    state: string;
    attributes: Attributes;
}

/** Una entrada del registro de entidades, en el formato compacto de `list_for_display`. */
export interface RegistryEntry {
    /** Integración que creó la entidad (`koolnova`, `daikin`…). */
    platform: string | null;
    deviceId: string | null;
    areaId: string | null;
}

export interface ServiceTarget {
    entity_id: string[];
}

/** Una llamada de servicio ya decidida: lo que el modelo produce y el cliente envía. */
export interface ServiceCall {
    domain: string;
    service: string;
    target: ServiceTarget;
    data?: Record<string, unknown>;
}

// --- Mensajes ---------------------------------------------------------------

/** Estado comprimido de `subscribe_entities`: s = estado, a = atributos. */
export interface CompressedState {
    s: string;
    a?: Attributes;
}

export interface CompressedDiff {
    '+'?: {s?: string; a?: Attributes};
    '-'?: {a?: string[]};
}

export interface EntitiesEvent {
    a?: Record<string, CompressedState>;
    c?: Record<string, CompressedDiff>;
    r?: string[];
}

export interface RawState {
    entity_id: string;
    state: string;
    attributes: Attributes;
}

export interface RawRegistryDisplay {
    entities: {ei: string; pl?: string; di?: string; ai?: string}[];
}

export interface HaError {
    code?: string;
    message?: string;
}

export type IncomingMessage =
    | {type: 'auth_required'; ha_version?: string}
    | {type: 'auth_ok'; ha_version?: string}
    | {type: 'auth_invalid'; message?: string}
    | {type: 'result'; id: number; success: boolean; result?: unknown; error?: HaError}
    | {type: 'event'; id: number; event: EntitiesEvent}
    | {type: 'pong'; id: number};
