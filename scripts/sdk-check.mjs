#!/usr/bin/env node
// Verify that the Proton SDK pin is consistent everywhere (run in CI and by
// `npm test`). Fails with an explanation instead of letting a half-done SDK bump
// build an image that mixes versions.
//
//  1. package.json pins @protontech/drive-sdk, @protontech/crypto and ky EXACTLY.
//  2. They equal src/server/proton/vendor/UPSTREAM.json (written by sdk:update).
//  3. node_modules contains exactly those versions (lockfile in sync).
//  4. The vendored account module is byte-identical to what sdk:update fetched
//     (no silent local edits — patches belong in src/server/proton/PATCHES.md).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const errors = [];

const pkg = read('package.json');
const up = read('src/server/proton/vendor/UPSTREAM.json');
const want = { '@protontech/drive-sdk': up.sdkVersion, '@protontech/crypto': up.crypto, ky: up.ky };

for (const [name, version] of Object.entries(want)) {
  const pinned = pkg.dependencies?.[name];
  if (pinned !== version) errors.push(`package.json pins ${name}@${pinned}, UPSTREAM.json expects ${version} — run \`npm run sdk:update\``);
  let installed = null;
  try {
    installed = read(`node_modules/${name}/package.json`).version;
  } catch {
    /* not installed */
  }
  if (installed !== version) errors.push(`node_modules has ${name}@${installed ?? 'missing'}, expected ${version} — run \`npm ci\``);
}
if (up.tag !== `js/v${up.sdkVersion}`) errors.push(`UPSTREAM.json tag ${up.tag} does not match sdkVersion ${up.sdkVersion}`);
if (!/^[0-9a-f]{40}$/.test(up.commit || '')) errors.push('UPSTREAM.json has no full upstream commit id');

const dir = path.join(ROOT, 'src/server/proton/vendor/account');
const present = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
const expected = Object.keys(up.accountModule.files).sort();
if (JSON.stringify(present) !== JSON.stringify(expected)) errors.push(`vendored account files differ from UPSTREAM.json: ${present.join(',')} vs ${expected.join(',')}`);
for (const f of expected) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) continue;
  const h = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (h !== up.accountModule.files[f]) errors.push(`vendored ${f} was modified locally (hash mismatch) — re-run \`npm run sdk:update\` or record a patch`);
}

if (errors.length) {
  console.error('sdk:check FAILED\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log(`sdk:check: @protontech/drive-sdk ${up.sdkVersion} (${up.tag} @ ${up.commit.slice(0, 12)}), crypto ${up.crypto}, ky ${up.ky} — consistent`);
