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
  // CJS deps inside an ESM bundle need a real require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'linked',
  minify: true,
  keepNames: true, // error class names are part of the error mapping contract
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'warning',
});

fs.writeFileSync(path.join(ROOT, 'dist-proton/meta.json'), JSON.stringify(result.metafile));
const bytes = fs.statSync(outfile).size;
console.log(`build-proton: ${path.relative(ROOT, outfile)} ${(bytes / 1024).toFixed(0)} KiB`);
