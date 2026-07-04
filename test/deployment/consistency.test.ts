import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Enforces the link the whole test suite exists to protect: every deployment mode
 * the project ADVERTISES in docker-compose.yml must be exercised by the Docker
 * smoke matrix (test/deployment/smoke.sh). This is what makes "advertised but
 * doesn't start" structurally impossible — you cannot document a hardening option
 * without also proving the container still boots under it.
 */
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('advertised deployment modes are covered by the smoke matrix', () => {
  const compose = read('docker-compose.yml');
  const smoke = read('test/deployment/smoke.sh');

  // feature → how compose advertises it → the flag smoke.sh uses to exercise it.
  const advertised: { feature: string; composeRe: RegExp; smokeRe: RegExp }[] = [
    { feature: 'read-only root fs', composeRe: /read_only:\s*true/, smokeRe: /--read-only/ },
    { feature: 'drop all capabilities', composeRe: /cap_drop:/, smokeRe: /--cap-drop ALL/ },
    { feature: 'no-new-privileges', composeRe: /no-new-privileges:true/, smokeRe: /no-new-privileges:true/ },
    { feature: 'non-root user', composeRe: /user:\s*["']?\d+:\d+/, smokeRe: /--user\s/ },
  ];

  for (const a of advertised) {
    it(`compose advertises "${a.feature}" and smoke.sh exercises it`, () => {
      expect(compose, `${a.feature} must be documented in docker-compose.yml`).toMatch(a.composeRe);
      expect(smoke, `${a.feature} must be exercised by test/deployment/smoke.sh`).toMatch(a.smokeRe);
    });
  }

  it('the PUID/PGID convenience layer is documented and smoke-tested (issue #20)', () => {
    expect(compose, 'PUID/PGID must be documented in docker-compose.yml').toMatch(/PUID/);
    expect(smoke, 'PUID/PGID must be exercised by test/deployment/smoke.sh').toMatch(/-e PUID=/);
  });

  it('the NET_ADMIN speed-limit opt-in is documented and its capability is smoke-tested (issue #23)', () => {
    expect(compose, 'the NET_ADMIN opt-in must be documented in docker-compose.yml').toMatch(/NET_ADMIN/);
    expect(smoke, 'the NET_ADMIN capability must be exercised by test/deployment/smoke.sh').toMatch(/--cap-add NET_ADMIN/);
  });

  it('smoke.sh proves real init via /api/backup-sets, not just static /api/health', () => {
    // /api/health returns a hardcoded {ok:true} without touching /data, so a broken
    // /data would still look healthy. The DB-backed route is the real readiness gate.
    expect(smoke).toMatch(/\/api\/health/);
    expect(smoke).toMatch(/\/api\/backup-sets/);
  });

  it('smoke.sh treats a read-only-filesystem error in the logs as a failure', () => {
    expect(smoke).toMatch(/read-only file system|EROFS/i);
  });
});
