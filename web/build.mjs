import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/draco', { recursive: true });
await build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: 'dist/app.js' });
cpSync('public', 'dist', { recursive: true });
cpSync('index.html', 'dist/index.html');
for (const f of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'])
  cpSync(`node_modules/three/examples/jsm/libs/draco/gltf/${f}`, `dist/draco/${f}`);
writeFileSync('dist/.nojekyll', '');
console.log('built dist/');
