// Empaqueta el TypeScript en módulos ES que GJS carga tal cual.
//
//   node build.mjs           la app        → build/js/main.js (meson la mete en el gresource)
//   node build.mjs --tests   las pruebas   → build/tests/*.js (se ejecutan con gjs -m)
//
// esbuild solo quita tipos y une ficheros; los tipos los vigila `npm run check` (tsc).

import {build} from 'esbuild';
import {readdirSync} from 'node:fs';

const tests = process.argv.includes('--tests');

const entryPoints = tests
    ? readdirSync('tests').filter(f => /\.(ui)?test\.ts$/.test(f) || f === 'mockServer.ts').map(f => `tests/${f}`)
    : ['src/main.ts'];

await build({
    entryPoints,
    outdir: tests ? 'build/tests' : 'build/js',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    // SpiderMonkey 115 (gjs 1.80 del portátil, donde corren las pruebas) o más nuevo.
    target: 'firefox115',
    external: ['gi://*', 'resource://*', 'system', 'gettext', 'cairo'],
    // Sin mapas de código: GJS no los usa en sus trazas. Sin minificar, para que las trazas se lean.
    logLevel: 'warning',
});
