#!/usr/bin/env node
// Update (or re-sync) the pinned Proton Drive SDK.
//
//   npm run sdk:update              # re-sync to the version already pinned in package.json
//   npm run sdk:update -- 0.23.0    # move the pin to another published SDK version
//   npm run sdk:update -- latest    # newest version on npm
//
// The ONE authoritative pin is `dependencies["@protontech/drive-sdk"]` in
// package.json. Everything else is derived from it:
//   * the upstream git tag `js/v<version>` and its commit,
//   * the incubating account module (not published to npm) vendored from that
//     commit into src/server/proton/vendor/account,
//   * the exact `@protontech/crypto` and `ky` versions the official CLI used at
//     that commit (cli/package.json, incubating/account/js/bun.lock),
//   * src/server/proton/vendor/UPSTREAM.json (tag, commit, versions, file hashes),
//     which the build embeds into the image and the diagnostics page.
// Afterwards it runs `npm install` so package-lock.json matches. `npm run sdk:check`
// (also part of `npm test`) verifies that all of this is consistent.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = process.env.PROTON_SDK_REPO || 'https://github.com/ProtonDriveApps/sdk.git';
const VENDOR = path.join(ROOT, 'src/server/proton/vendor');
const ACCOUNT_DIR = path.join(VENDOR, 'account');
const SDK_PKG = '@protontech/drive-sdk';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const pkgPath = path.join(ROOT, 'package.json');
const pkg = readJson(pkgPath);
let version = process.argv[2] || pkg.dependencies[SDK_PKG];
if (version === 'latest') version = sh('npm', ['view', SDK_PKG, 'version']);
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`sdk:update: expected an exact version like 0.23.0, got "${version}"`);
  process.exit(2);
}
const tag = `js/v${version}`;

// Shallow clone of exactly the release tag.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'proton-sdk-'));
console.log(`sdk:update: fetching ${tag} from ${REPO}`);
sh('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, REPO, work]);
const commit = sh('git', ['-C', work, 'rev-parse', 'HEAD']);

const upstreamSdk = readJson(path.join(work, 'client/js/package.json'));
if (upstreamSdk.version !== version && upstreamSdk.version !== '0.0.1') {
  // client/js keeps "0.0.1" in git; releases are versioned by tag. Anything else
  // that disagrees with the tag means the tag is not what we think it is.
  console.error(`sdk:update: ${tag} contains client/js version ${upstreamSdk.version}`);
  process.exit(1);
}
const cliPkg = readJson(path.join(work, 'cli/package.json'));
const cryptoVersion = cliPkg.dependencies['@protontech/crypto'];
if (!/^\d+\.\d+\.\d+$/.test(cryptoVersion || '')) {
  console.error(`sdk:update: cannot derive an exact @protontech/crypto pin from cli/package.json (${cryptoVersion})`);
  process.exit(1);
}
const lock = fs.readFileSync(path.join(work, 'incubating/account/js/bun.lock'), 'utf8');
const kyVersion = (lock.match(/"ky": \["ky@(\d+\.\d+\.\d+)"/) || [])[1];
if (!kyVersion) {
  console.error('sdk:update: cannot find the resolved ky version in incubating/account/js/bun.lock');
  process.exit(1);
}

// Vendor the account module: every non-test .ts file, byte-for-byte.
const src = path.join(work, 'incubating/account/js/src');
fs.rmSync(ACCOUNT_DIR, { recursive: true, force: true });
fs.mkdirSync(ACCOUNT_DIR, { recursive: true });
const files = {};
for (const name of fs.readdirSync(src).sort()) {
  if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
  const buf = fs.readFileSync(path.join(src, name));
  fs.writeFileSync(path.join(ACCOUNT_DIR, name), buf);
  files[name] = sha256(buf);
}
fs.copyFileSync(path.join(work, 'LICENSE.md'), path.join(ACCOUNT_DIR, 'LICENSE.md'));

const upstream = {
  sdkVersion: version,
  tag,
  commit,
  repository: REPO.replace(/\.git$/, ''),
  crypto: cryptoVersion,
  ky: kyVersion,
  accountModule: { path: 'incubating/account/js/src', files },
};
fs.writeFileSync(path.join(VENDOR, 'UPSTREAM.json'), JSON.stringify(upstream, null, 2) + '\n');

// Pin the npm side to the same set, exactly.
pkg.dependencies[SDK_PKG] = version;
pkg.dependencies['@protontech/crypto'] = cryptoVersion;
pkg.dependencies.ky = kyVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
fs.rmSync(work, { recursive: true, force: true });

console.log(`sdk:update: ${SDK_PKG}@${version} (${commit.slice(0, 12)}), crypto ${cryptoVersion}, ky ${kyVersion}`);
if (!process.env.SDK_UPDATE_SKIP_INSTALL) {
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' });
}
console.log('sdk:update: done. Next: npm run sdk:check && npm test && npm run build');
