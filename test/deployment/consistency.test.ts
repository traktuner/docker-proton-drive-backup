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

  // Issue #72: nested per-share mounts under /sources. The two safe layouts must
  // be advertised in docker-compose.yml AND exercised by the smoke matrix.
  it('compose documents the read-only-parent pitfall from issue #72', () => {
    // The exact runc wording, so the docs carry the searchable error text —
    // NOT just any "read-only file system" mention (smoke.sh has unrelated ones).
    expect(compose).toMatch(/make mountpoint/);
    expect(compose).toMatch(/#72/);
  });

  it('the two safe nested-source layouts from issue #72 are advertised and smoke-tested', () => {
    // (a) read-write parent so runc can create the nested mountpoints …
    expect(compose).toMatch(/\/sources:rw/);
    // … and (b) no parent mount at all — compose says "Drop the parent mount".
    expect(compose).toMatch(/Drop the parent mount/);
    // Both layouts are exercised by run_nested_mode, with the mount_parent_rw
    // argument pinned so layout (b) cannot silently become layout (a):
    // run_nested_mode "<name>" "<extra>" <1=rw-parent | 0=no-parent> [nonroot [uid]]
    expect(smoke).toMatch(/run_nested_mode "nested-rw-parent"\s+"[^"]*"\s+1/);
    expect(smoke).toMatch(/run_nested_mode "nested-no-parent"\s+"[^"]*"\s+0/);
    // …and the hardened pairings (read-only rootfs + non-root; PUID drop).
    expect(smoke).toMatch(/run_nested_mode "nested-rw-parent-ro"\s+"--read-only[^"]*"\s+1/);
    expect(smoke).toMatch(/run_nested_mode "nested-no-parent-puid"\s+"-e PUID=/);
  });

  it('smoke.sh proves nested shares are READABLE, not just present, via /api/local/list', () => {
    // The check must list each share's CONTENTS and require the sample file —
    // the mountpoint directory name alone appears in listings regardless of
    // whether the share inside is actually readable.
    expect(smoke).toMatch(/api\/local\/list\?path=%2F\$e/);
    expect(smoke).toMatch(/EXPECT_SOURCE_ENTRIES/);
    expect(smoke).toMatch(/sample-\$e\.txt/);
  });

  it('the Dockerfile bakes /sources so per-share mounts need no parent bind (issue #72)', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/^\s*RUN mkdir -p \/sources$/m);
    // …but does NOT declare it a VOLUME (that would spawn a stray writable
    // anonymous volume at the /sources root on every run).
    expect(dockerfile).not.toMatch(/^\s*VOLUME.*sources/m);
  });

  it('the runc read-only-parent failure is explained where users will look for it', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/#72/);
    expect(readme).toMatch(/make mountpoint/);
    // README shows BOTH safe layouts — layout (a) explicitly, and layout (b) as
    // its own yaml block whose mount lines ALL target /sources/<sub> and NONE
    // targets the parent /sources itself.
    expect(readme).toMatch(/\/sources:rw/);
    const yamlBlocks = readme.match(/```yaml[\s\S]*?```/g) ?? [];
    const noParentBlock = yamlBlocks.some((block) => {
      // Mount lines only; drop the fences and skip comments/other lines.
      const mounts = block
        .split('\n')
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter((l) => /^-\s+/.test(l));
      return (
        mounts.length > 0 &&
        mounts.every((l) => /:\/sources\//.test(l))
      );
    });
    expect(
      noParentBlock,
      'README must contain a yaml block showing layout (b): nested mounts only, no parent bind at /sources',
    ).toBe(true);
  });

  it('the ACTIVE compose volumes never pair a read-only /sources parent with nested mounts', () => {
    // The default compose guidance ships `- ./sources:/sources:ro` plus the
    // commented multi-source examples. This guards docker-compose.yml itself
    // against the exact broken setup from issue #72: an ACTIVE (uncommented)
    // nested mount under /sources while the :ro parent stays active.
    const activeVolumeLines = compose
      .split('\n')
      // strip comments, keep real volume entries
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter((l) => /^-\s+\S+:\/sources/.test(l));
    const hasRoParent = activeVolumeLines.some((l) => /:\/sources:ro\s*$/.test(l));
    const hasNested = activeVolumeLines.some((l) => /:\/sources\//.test(l));
    expect(
      !(hasRoParent && hasNested),
      'compose must not activate a read-only /sources parent together with nested mounts (issue #72)',
    ).toBe(true);
  });

  it('nested mount modes never combine a read-only parent with nested mounts', () => {
    // Extract the run_nested_mode body: every SOURCES_MOUNTS assignment there
    // derives the parent flags from $pdir. A read-only parent would show up as
    // "$pdir:/sources:ro" or ":/sources:ro" in that assignment line.
    const assignLine = smoke.split('\n').find((l) => l.includes('SOURCES_MOUNTS="$parent_flags'));
    expect(assignLine, 'run_nested_mode must build SOURCES_MOUNTS from $parent_flags').toBeTruthy();
    expect(assignLine!).not.toMatch(/:\/sources:ro/);
    // And $parent_flags itself may only ever be :rw.
    const parentFlagLine = smoke.split('\n').find((l) => l.includes('parent_flags="-v $pdir'));
    expect(parentFlagLine, 'run_nested_mode must define $parent_flags').toBeTruthy();
    expect(parentFlagLine!).toMatch(/:\/sources:rw/);
    expect(parentFlagLine!).not.toMatch(/:\/sources:ro/);
  });
});
