import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const outDir = path.resolve('client/public/vendor');
const outFile = path.join(outDir, 'mediasoup-client.min.js');
fs.mkdirSync(outDir, { recursive: true });

const candidates = [
  'node_modules/mediasoup-client/lib/index.js',
  'node_modules/mediasoup-client/lib-esm/index.js',
  'node_modules/mediasoup-client/src/index.ts'
];

const entry = candidates.find((p) => fs.existsSync(path.resolve(p)));
if (!entry) {
  console.error('Could not find mediasoup-client entry in node_modules.');
  process.exit(1);
}

await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'mediasoupClient',
  platform: 'browser',
  outfile: outFile,
  logLevel: 'info'
});

console.log(`Bundled mediasoup-client from ${entry} -> ${outFile}`);
