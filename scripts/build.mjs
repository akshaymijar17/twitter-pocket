// Bundles the extension into dist/. MV3 cannot load remote code, so everything
// (including our shared modules) is bundled into each entry point.
import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const watch = process.argv.includes('--watch');
const out = 'dist';

if (!existsSync('src/config.ts')) {
  console.error('Missing src/config.ts. Copy src/config.example.ts to src/config.ts and fill it in (see README).');
  process.exit(1);
}

async function loadConfig() {
  const r = await esbuild.build({ entryPoints: ['src/config.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
  const mod = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
  return mod.CONFIG;
}

function writeStatic(config) {
  mkdirSync(`${out}/icons`, { recursive: true });
  const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
  if (config.manifestKey) manifest.key = config.manifestKey;
  else console.warn('warning: CONFIG.manifestKey is empty; the extension ID (and OAuth redirect URI) will change if you move the folder. Run `npm run make-key`.');
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
  for (const f of ['popup/popup.html', 'popup/shared.css', 'options/options.html']) copyFileSync(`src/${f}`, `${out}/${f.split('/')[1]}`);
  for (const size of [16, 32, 48, 128]) writeFileSync(`${out}/icons/${size}.png`, icon(size));
}

/** A black square with a white bookmark ribbon, drawn as a PNG without dependencies. */
function icon(n) {
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      const inRibbon = u > 0.3 && u < 0.7 && v > 0.2 && v < 0.82 && !(v > 0.62 && Math.abs(u - 0.5) < (v - 0.62) * 1.0);
      const c = inRibbon ? 255 : 0;
      raw.set([c, c, c, 255], y * (n * 4 + 1) + 1 + x * 4);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, k) => {
    let c = k;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const config = await loadConfig();
rmSync(out, { recursive: true, force: true });
writeStatic(config);

const ctx = await esbuild.context({
  entryPoints: {
    hook: 'src/main-world/hook.ts',
    content: 'src/content/content.ts',
    background: 'src/background/sw.ts',
    popup: 'src/popup/popup.ts',
    options: 'src/options/options.ts',
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome111',
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
});
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
