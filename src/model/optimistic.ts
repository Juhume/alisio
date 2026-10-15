// Lo pedido, mostrado al instante, sin mentir sobre lo real.
//
// Al tocar un control, la ventana enseña ya el valor nuevo y marca la zona como "en curso".
// Esa expectativa se retira cuando el estado real coincide, cuando HA rechaza la orden, o
// 5 s después de que HA la confirme sin que el estado cambie: entonces manda lo real y la
// orden queda apuntada como incumplida, para avisar de que el aparato no respondió.
// Sin el margen tras la confirmación, una zona haría on → off → on: HA confirma la orden un
// instante antes de que llegue el estado nuevo (lección del prototipo).

import type {Climate} from './capabilities.js';

export type Field = 'on' | 'targetValue' | 'fan' | 'mode';
type Value = Climate[Field];

const CONFIRMED_GRACE_MS = 5000;
const UNCONFIRMED_LIMIT_MS = 25_000; // por encima del plazo de 20 s del cliente

interface Expectation {
    value: Value;
    deadline: number;
    confirmed: boolean;
}

/** Una orden que HA aceptó pero que el aparato no cumplió a tiempo. */
export interface Unfulfilled {
    id: string;
    field: Field;
}

export class Optimistic {
    private readonly _expected = new Map<string, Map<Field, Expectation>>();
    private _unfulfilled: Unfulfilled[] = [];

    /** @param now reloj en milisegundos (se inyecta para poder probar el paso del tiempo) */
    constructor(private readonly _now: () => number) {}

    expect(id: string, field: Field, value: Value): void {
        const fields = this._expected.get(id) ?? new Map();
        fields.set(field, {value, deadline: this._now() + UNCONFIRMED_LIMIT_MS, confirmed: false});
        this._expected.set(id, fields);
    }

    /** HA aceptó la orden: desde aquí, 5 s para que llegue el estado. */
    confirmed(id: string, field: Field): void {
        const e = this._expected.get(id)?.get(field);
        if (e) {
            e.confirmed = true;
            e.deadline = Math.min(e.deadline, this._now() + CONFIRMED_GRACE_MS);
        }
    }

    /** HA rechazó la orden: vuelve lo real. */
    cancel(id: string, field: Field): void {
        this._expected.get(id)?.delete(field);
    }

    /** El clima con lo pedido encima; retira las expectativas cumplidas o caducadas. */
    apply(c: Climate): Climate {
        const fields = this._expected.get(c.id);
        if (!fields)
            return c;
        const now = this._now();
        const view = {...c};
        for (const [field, e] of fields) {
            if (c[field] === e.value) {
                fields.delete(field);
            } else if (now >= e.deadline) {
                // HA dijo que sí, pero el aparato no cambió: hay que contarlo, no callarlo.
                // (Algunas integraciones, como Koolnova, responden "ok" aunque su nube falle.)
                if (e.confirmed)
                    this._unfulfilled.push({id: c.id, field});
                fields.delete(field);
            } else
                (view as Record<Field, Value>)[field] = e.value;
        }
        return view;
    }

    /** Las órdenes confirmadas que no se cumplieron desde la última llamada. */
    takeUnfulfilled(): Unfulfilled[] {
        const taken = this._unfulfilled;
        this._unfulfilled = [];
        return taken;
    }

    isPending(id: string): boolean {
        return (this._expected.get(id)?.size ?? 0) > 0;
    }

    /** Cuándo caduca la próxima expectativa (para repintar entonces), o null. */
    nextDeadline(): number | null {
        let next: number | null = null;
        for (const fields of this._expected.values()) {
            for (const e of fields.values())
                next = next === null ? e.deadline : Math.min(next, e.deadline);
        }
        return next;
    }
}
