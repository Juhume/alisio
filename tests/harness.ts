// Mini arnés de pruebas para gjs: check() imprime ✓/✗ y until() gira el bucle de GLib
// hasta que se cumple una condición. Sin dependencias: lo mismo que usaba el prototipo.

import GLib from 'gi://GLib';
import system from 'system';

let failures = 0;
let checks = 0;

export function check(cond: unknown, label: string): void {
    checks++;
    print(`${cond ? '  ✓' : '  ✗'} ${label}`);
    if (!cond)
        failures++;
}

export function section(title: string): void {
    print(title);
}

/** Igualdad profunda para objetos JSON (llamadas, listas…). */
export function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Espera (girando el bucle) hasta que se cumpla `cond` o venza el plazo. */
export function until(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
    return new Promise(resolve => {
        const start = GLib.get_monotonic_time();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            if (cond() || (GLib.get_monotonic_time() - start) / 1000 > timeoutMs) {
                resolve(cond());
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    });
}

export const sleep = (ms: number) => until(() => false, ms);

/** Ejecuta las pruebas en orden dentro de un bucle de GLib y sale con 1 si algo falla. */
export function run(tests: (() => Promise<void> | void)[]): void {
    const loop = new GLib.MainLoop(null, false);
    (async () => {
        try {
            for (const test of tests)
                await test();
        } catch (e) {
            failures++;
            print(`EXCEPCIÓN: ${e}\n${(e as Error).stack ?? ''}`);
        }
        print(failures ? `\n${failures} de ${checks} fallan` : `\n${checks} comprobaciones en verde`);
        loop.quit();
    })();
    loop.run();
    if (failures)
        system.exit(1);
}
