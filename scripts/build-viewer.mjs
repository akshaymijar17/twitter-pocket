// Bundles the viewer (Firebase SDK + JSZip from npm) into viewer/public for Firebase Hosting.
import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const out = 'viewer/public';
mkdirSync(out, { recursive: true });
copyFileSync('viewer/index.html', `${out}/index.html`);
if (existsSync('viewer/config.js')) copyFileSync('viewer/config.js', `${out}/config.js`);
else console.warn('warning: viewer/config.js missing. Copy viewer/config.example.js to viewer/config.js and fill it in.');
await esbuild.build({
  entryPoints: ['viewer/src/app.js'],
  outfile: `${out}/app.js`,
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  logLevel: 'info',
});
