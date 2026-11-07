#!/usr/bin/env node
// Bundle the Proton SDK boundary (src/server/proton/runtime.ts) with
// @protontech/drive-sdk, @protontech/crypto (TypeScript-only on npm), openpgp, ky
// and the vendored account module into ONE ES module: dist-proton/runtime.mjs.
//
// The Next.js server loads that file once per process (src/server/drive.ts), so
// the SDK, its CryptoProxy singleton and the session exist exactly once — never
// duplicated across route bundles. Native packages (sharp) stay external.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Patch 7 (PATCHES.md): the SDK buffers up to 15 encrypted 4 MiB blocks per file
// ahead of the 5 block uploads. Encryption is ~100x faster than the upload, so a
// few blocks of lead are enough; 15 only cost memory (production: ~400 MB of
// ArrayBuffers for ONE file). Default 6, env PDB_SDK_BUFFERED_BLOCKS. The build
// fails if upstream changes the line, so an SDK update can't drop the patch silently.
const SDK_PATCHES = [
  {
    file: /drive-sdk[\\/]dist[\\/]internal[\\/]upload[\\/]streamUploader\.js$/,
    from: 'const MAX_BUFFERED_BLOCKS = 15;',
    to: 'const MAX_BUFFERED_BLOCKS = Math.max(1, Number(process.env.PDB_SDK_BUFFERED_BLOCKS) || 6);',
  },
];
const applied = new Set();
const sdkPatches = {
  name: 'sdk-patches',
  setup(b) {
    b.onLoad({ filter: /drive-sdk[\\/]dist[\\/].*\.js$/ }, (args) => {
      const patch = SDK_PATCHES.find((p) => p.file.test(args.path));
      if (!patch) return undefined;
      const src = fs.readFileSync(args.path, 'utf8');
      if (!src.includes(patch.from)) throw new Error(`SDK patch no longer applies to ${args.path}: "${patch.from}" not found`);
      applied.add(patch.from);
      return { contents: src.replace(patch.from, patch.to), loader: 'js' };
    });
  },
};
const outfile = path.join(ROOT, 'dist-proton/runtime.mjs');

const result = await build({
  entryPoints: [path.join(ROOT, 'src/server/proton/runtime.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  // Patch 1 (see src/server/proton/PATCHES.md): @protontech/crypto imports the
  // browser-only `openpgp/lightweight` entry; use the Node build of openpgp.
  alias: { 'openpgp/lightweight': 'openpgp' },
  conditions: ['node', 'import'],
  external: ['sharp'],
  plugins: [sdkPatches],
  // CJS deps inside an ESM bundle need a real require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'linked',
  minify: true,
  keepNames: true, // error class names are part of the error mapping contract
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'warning',
});

for (const p of SDK_PATCHES) if (!applied.has(p.from)) throw new Error(`SDK patch not applied (file not bundled?): ${p.from}`);
fs.writeFileSync(path.join(ROOT, 'dist-proton/meta.json'), JSON.stringify(result.metafile));
const bytes = fs.statSync(outfile).size;
console.log(`build-proton: ${path.relative(ROOT, outfile)} ${(bytes / 1024).toFixed(0)} KiB`);
