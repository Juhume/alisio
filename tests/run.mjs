// Ejecuta cada build/tests/*.test.js con el gjs del portátil y resume. Sale con 1 si alguno
// falla. Las *.uitest.js necesitan la libadwaita del runtime: van con `npm run test:ui`.
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';

const files = readdirSync('build/tests').filter(f => f.endsWith('.test.js') && !f.endsWith('.uitest.js')).sort();
const failed = [];
for (const file of files) {
    console.log(`\n▸ ${file}`);
    const {status} = spawnSync('gjs', ['-m', `build/tests/${file}`], {stdio: 'inherit'});
    if (status !== 0)
        failed.push(file);
}
console.log(failed.length ? `\n✗ Fallan: ${failed.join(', ')}` : `\n✓ ${files.length} ficheros en verde`);
process.exit(failed.length ? 1 : 0);
