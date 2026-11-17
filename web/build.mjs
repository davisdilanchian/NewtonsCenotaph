import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const out = process.env.OUT || 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/draco`, { recursive: true });
await build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: `${out}/app.js` });
cpSync('public', out, { recursive: true });
cpSync('index.html', `${out}/index.html`);
for (const f of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'])
  cpSync(`node_modules/three/examples/jsm/libs/draco/gltf/${f}`, `${out}/draco/${f}`);
writeFileSync(`${out}/.nojekyll`, '');
console.log(`built ${out}/`);
