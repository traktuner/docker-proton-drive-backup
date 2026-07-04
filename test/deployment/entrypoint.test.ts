import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Fast, Docker-free regression guards for the container start-up contract that
 * broke in #19 (read-only root aborts on `mkdir /config`) and matters for #20
 * (running as a non-root `user:`). These read the actual shipped files, so a
 * future edit that reintroduces the hazard fails `npm test` immediately — long
 * before the (slower) Docker smoke matrix runs in CI.
 */
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('docker-entrypoint.sh — read-only / non-root start invariants (#19, #20)', () => {
  const entry = read('docker-entrypoint.sh');
  const mkdirLines = entry
    .split('\n')
    .filter((l) => /(^|\s)mkdir\b/.test(l) && !l.trimStart().startsWith('#'));

  it('never `mkdir`s /config — it is read-only input and aborts on a read-only root', () => {
    for (const l of mkdirLines) expect(l).not.toMatch(/\/config(\b|\/|"|\s|$)/);
    // belt-and-suspenders: no mkdir of /config anywhere, commented lines excluded
    expect(entry).not.toMatch(/^\s*mkdir[^\n#]*\/config/m);
  });

  it('creates every dir best-effort (|| true) so a read-only mount cannot abort startup', () => {
    expect(mkdirLines.length).toBeGreaterThan(0);
    for (const l of mkdirLines) expect(l).toMatch(/\|\|\s*true/);
  });

  it('keeps `set -e` and the `exec …"$@"` handoff intact', () => {
    expect(entry).toMatch(/^set -e/m);
    expect(entry).toMatch(/exec [^\n]*"\$@"/);
  });

  it('exports a writable HOME defaulting under /data (off the read-only root)', () => {
    expect(entry).toMatch(/export HOME=/);
    expect(entry).toMatch(/HOME="?\$\{HOME:-\/data/);
  });
});

describe('docker-entrypoint.sh — PUID/PGID privilege drop (issue #20)', () => {
  const entry = read('docker-entrypoint.sh');

  it('only drops privileges when it starts as root (skips a compose `user:`)', () => {
    // Guard: `id -u` == 0 gate, so a container already launched non-root is untouched.
    expect(entry).toMatch(/id -u.*=.*0|"\$\(id -u\)"\s*=\s*"?0/);
  });

  it('acts on PUID/PGID, chowns the writable volume, and drops via setpriv/gosu', () => {
    expect(entry).toMatch(/PUID/);
    expect(entry).toMatch(/PGID/);
    expect(entry).toMatch(/chown -R .*\/data/);
    expect(entry).toMatch(/setpriv|gosu/);
  });
});

describe('Dockerfile / cli.ts — HOME on the writable volume, never /home/app (#19, #20)', () => {
  const dockerfile = read('Dockerfile');
  const cli = read('src/server/cli.ts');

  it('Dockerfile bakes HOME onto /data, not the nonexistent /home/app', () => {
    expect(dockerfile).toMatch(/HOME=\/data\//);
    expect(dockerfile).not.toMatch(/HOME=\/home\/app/);
  });

  it('cli.ts falls HOME back to the writable CACHE_DIR, not /home/app', () => {
    expect(cli).not.toContain("'/home/app'");
    expect(cli).toMatch(/HOME:\s*process\.env\.HOME\s*\|\|\s*CACHE_DIR/);
  });
});
