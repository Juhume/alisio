// El token de Home Assistant vive en el llavero del sistema (libsecret), nunca en GSettings,
// que es un fichero en claro. Dentro del Flatpak, libsecret usa por sí sola el portal Secret:
// guarda en un llavero propio de la app, cifrado con una clave que da el escritorio.
//
// Promesas a mano en vez de Gio._promisify: explícito y sin parchear espacios de nombres.

import Gio from 'gi://Gio';
import Secret from 'gi://Secret';

// GJS acepta aquí un objeto {atributo: tipo}; los tipos generados lo declaran como array.
const SCHEMA = new Secret.Schema('io.github.juhume.Alisio', Secret.SchemaFlags.NONE, {
    server: Secret.SchemaAttributeType.STRING,
} as unknown as unknown[]);

/** Un token por servidor: cambiar de dirección no reutiliza el token de otra casa. */
const attributes = (server: string) => ({server: normalize(server)});

function normalize(server: string): string {
    return server.trim().replace(/\/+$/, '').toLowerCase();
}

type Callback = (source: unknown, result: Gio.AsyncResult) => void;

function promised<T>(start: (cb: Callback) => void, finish: (r: Gio.AsyncResult) => T): Promise<T> {
    return new Promise((resolve, reject) => {
        start((_source, result) => {
            try {
                resolve(finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function lookupToken(server: string): Promise<string | null> {
    return promised(
        cb => Secret.password_lookup(SCHEMA, attributes(server), null, cb),
        r => Secret.password_lookup_finish(r));
}

export function storeToken(server: string, token: string): Promise<boolean> {
    return promised(
        cb => Secret.password_store(SCHEMA, attributes(server), Secret.COLLECTION_DEFAULT,
            `Alisio: Home Assistant en ${normalize(server)}`, token, null, cb),
        r => Secret.password_store_finish(r));
}

export function clearToken(server: string): Promise<boolean> {
    return promised(
        cb => Secret.password_clear(SCHEMA, attributes(server), null, cb),
        r => Secret.password_clear_finish(r));
}
