#!/usr/bin/env node
// Type-check the SDK boundary (src/server/proton/runtime.ts) against the pinned
// SDK, crypto and account typings. @protontech/crypto ships TypeScript SOURCE that
// upstream compiles with its own TypeScript version, so diagnostics located inside
// node_modules or in the byte-for-byte vendored account module are reported but do
// not fail the check; everything in our own boundary code does. A breaking SDK
// update therefore fails HERE, with the offending call site, instead of at runtime.
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['tsc', '-p', 'tsconfig.proton.json', '--pretty', 'false'], { encoding: 'utf8' });
const lines = (r.stdout + r.stderr).split('\n').filter(Boolean);
const ours = lines.filter((l) => /^src\/server\/proton\/(?!vendor\/)/.test(l));
const upstream = lines.filter((l) => /^(node_modules|src\/server\/proton\/vendor)\//.test(l));
if (upstream.length) console.log(`typecheck:proton: ${upstream.length} diagnostic(s) inside upstream sources (not ours, informational)`);
if (ours.length) {
  console.error('typecheck:proton: the SDK boundary does not match the pinned SDK API:\n' + ours.join('\n'));
  process.exit(1);
}
console.log('typecheck:proton: ok');
