import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the CLI (the only real-I/O / network layer the engine touches). Keep the
// pure helpers (normalizeProtonPath / looksUnauthenticated) as the real impls so
// path normalisation and the auth-string detection behave exactly as in prod;
// stub everything that would spawn the proton-drive binary or hit Drive.
vi.mock('@/server/cli', async (importActual) => {
  const actual = await importActual<typeof import('@/server/cli')>();
  return {
    ...actual,
    // pass-through pure helpers
    normalizeProtonPath: actual.normalizeProtonPath,
    looksUnauthenticated: actual.looksUnauthenticated,
    // stubbed I/O — overwritten per-test via the spies below
    upload: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    createFolder: vi.fn(async () => ({ ok: true, data: {} })),
    trashDrive: vi.fn(async () => ({ ok: true, data: {} })),
    listDrive: vi.fn(async () => ({ ok: true, data: [] })),
  };
});

// Import AFTER the mock is registered. relBaseFor / runCatalogDelta come from the
// engine; the catalog + LOCAL_ROOT come from the real (DB-backed) modules.
import { relBaseFor, runCatalogDelta, previewDelta } from '@/server/engine';
import * as cli from '@/server/cli';
import { catalog } from '@/server/catalog';
import { LOCAL_ROOT } from '@/server/local';
import { getDb } from '@/server/db';
import { setMirrorSafetyConfig } from '@/server/mirror-safety';

const upload = vi.mocked(cli.upload);
const createFolder = vi.mocked(cli.createFolder);
const trashDrive = vi.mocked(cli.trashDrive);

// Convenience: write a fixture file under LOCAL_ROOT (relative path), creating
// parent dirs. Returns its absolute path.
async function writeFixture(rel: string, content = 'x'): Promise<string> {
  const abs = path.join(LOCAL_ROOT, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
  return abs;
}

beforeEach(() => {
  // Touch the catalog once so its table is created (catalog.ts creates it lazily
  // on first use), then wipe it for a fresh per-test state.
  catalog.count('__warm__');
  getDb().exec('DELETE FROM backup_catalog');
  upload.mockClear();
  createFolder.mockClear();
  trashDrive.mockClear();
  // Every test starts with the historical behavior used by existing installs.
  setMirrorSafetyConfig({ enabled: true, deleteSafetyPct: 0.3 });
  // Reset to the default happy-path implementations (tests may override).
  upload.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  createFolder.mockResolvedValue({ ok: true, data: {} } as any);
  trashDrive.mockResolvedValue({ ok: true, data: {} } as any);
});

describe('relBaseFor (pure)', () => {
  it('prefixes the source rel-to-LOCAL_ROOT with the subfolder', () => {
    const abs = path.join(LOCAL_ROOT, 'foldera', 'Fotos');
    expect(relBaseFor('MySet', abs)).toBe('MySet/foldera/Fotos');
  });

  it('returns just the subfolder when abs === LOCAL_ROOT', () => {
    expect(relBaseFor('MySet', LOCAL_ROOT)).toBe('MySet');
  });

  it('handles a direct child of LOCAL_ROOT', () => {
    const abs = path.join(LOCAL_ROOT, 'photos');
    expect(relBaseFor('Backup', abs)).toBe('Backup/photos');
  });
});

describe('runCatalogDelta — first run (recursive seed path)', () => {
  it('counts new files, uploads, and writes the catalog', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'src');
    await writeFixture('src/a.txt', 'aaa');
    await writeFixture('src/sub/b.txt', 'bbbb');

    const res = await runCatalogDelta('set1', [srcDir], '/', 'Set', 'backup');

    expect(res.ok).toBe(true);
    expect(res.cancelled).toBe(false);
    expect(res.newCount).toBe(2);
    expect(res.message).toBe('2 uploaded');
    // The seed path uploads (at least once) via uploadSourceTrees.
    expect(upload).toHaveBeenCalled();
    // Catalog now records both files (keyed by "<subfolder>/<src-rel>/…").
    expect(catalog.count('set1')).toBeGreaterThanOrEqual(2);
    expect(catalog.getFile('set1', 'Set/src/a.txt')).toBeDefined();
    expect(catalog.getFile('set1', 'Set/src/sub/b.txt')).toBeDefined();
    // The directory rows are recorded too (so a later mirror pass can touch them).
    expect(catalog.hasDir('set1', 'Set/src')).toBe(true);
    expect(catalog.hasDir('set1', 'Set/src/sub')).toBe(true);
  });
});

describe('runCatalogDelta — second run with no changes', () => {
  it('reports everything unchanged and uploads nothing', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'src2');
    await writeFixture('src2/a.txt', 'aaa');
    await writeFixture('src2/b.txt', 'bbbb');

    // First run seeds the catalog (recursive seed path).
    await runCatalogDelta('set2', [srcDir], '/', 'Set', 'backup');
    upload.mockClear();

    // Second run: catalog is non-empty → per-file diff path. No changes on disk.
    const res = await runCatalogDelta('set2', [srcDir], '/', 'Set', 'backup');

    expect(res.ok).toBe(true);
    expect(res.newCount).toBe(0);
    expect(res.changedCount).toBe(0);
    expect(res.unchangedCount).toBe(2);
    expect(res.message).toContain('2 unchanged');
    // Nothing re-uploaded.
    expect(upload).not.toHaveBeenCalled();
  });

  it('detects a changed file (size differs) and re-uploads only it', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'src3');
    await writeFixture('src3/a.txt', 'aaa');
    await writeFixture('src3/b.txt', 'bbbb');

    await runCatalogDelta('set3', [srcDir], '/', 'Set', 'backup');
    upload.mockClear();

    // Grow a.txt so its size differs from the catalog → 'changed'.
    await writeFixture('src3/a.txt', 'aaaaaaaaaaaa');

    const res = await runCatalogDelta('set3', [srcDir], '/', 'Set', 'backup');

    expect(res.changedCount).toBe(1);
    expect(res.unchangedCount).toBe(1);
    expect(res.newCount).toBe(0);
    // Exactly one batch upload for the single changed file.
    expect(upload).toHaveBeenCalledTimes(1);
    const [absList] = upload.mock.calls[0];
    expect(absList).toEqual([path.join(srcDir, 'a.txt')]);
  });

  it('detects a brand-new file added after the seed', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'src4');
    await writeFixture('src4/a.txt', 'aaa');

    await runCatalogDelta('set4', [srcDir], '/', 'Set', 'backup');
    upload.mockClear();

    await writeFixture('src4/c.txt', 'cccc');

    const res = await runCatalogDelta('set4', [srcDir], '/', 'Set', 'backup');

    expect(res.newCount).toBe(1);
    expect(res.unchangedCount).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(catalog.getFile('set4', 'Set/src4/c.txt')).toBeDefined();
  });
});

describe('runCatalogDelta — source addition without catalog reset (issue #51)', () => {
  it('uploads only the added source and never re-uploads unchanged existing files', async () => {
    const original = path.join(LOCAL_ROOT, 'source-add-old');
    const added = path.join(LOCAL_ROOT, 'source-add-new');
    await writeFixture('source-add-old/keep.txt', 'old-data');
    await runCatalogDelta('source-add-set', [original], '/', 'Set', 'backup');
    await writeFixture('source-add-new/new.txt', 'new-data');
    upload.mockClear();

    const res = await runCatalogDelta('source-add-set', [original, added], '/', 'Set', 'backup');

    expect(res.newCount).toBe(1);
    expect(res.changedCount).toBe(0);
    expect(res.unchangedCount).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toEqual([path.join(added, 'new.txt')]);
    expect(catalog.getFile('source-add-set', 'Set/source-add-old/keep.txt')).toBeDefined();
    expect(catalog.getFile('source-add-set', 'Set/source-add-new/new.txt')).toBeDefined();
  });

  it('still uploads a changed existing file while also adding the new source', async () => {
    const original = path.join(LOCAL_ROOT, 'source-change-old');
    const added = path.join(LOCAL_ROOT, 'source-change-new');
    await writeFixture('source-change-old/changed.txt', 'old');
    await runCatalogDelta('source-change-set', [original], '/', 'Set', 'backup');
    await writeFixture('source-change-old/changed.txt', 'longer-current-data');
    await writeFixture('source-change-new/new.txt', 'new');
    upload.mockClear();

    const res = await runCatalogDelta('source-change-set', [original, added], '/', 'Set', 'backup');
    const uploaded = upload.mock.calls.flatMap(([files]) => files).sort();

    expect(res.newCount).toBe(1);
    expect(res.changedCount).toBe(1);
    expect(uploaded).toEqual([
      path.join(original, 'changed.txt'),
      path.join(added, 'new.txt'),
    ].sort());
  });

  it('does not classify retained Mirror files as stale after adding a source', async () => {
    const original = path.join(LOCAL_ROOT, 'source-mirror-old');
    const added = path.join(LOCAL_ROOT, 'source-mirror-new');
    for (let i = 0; i < 10; i++) await writeFixture(`source-mirror-old/f${i}.txt`, `old-${i}`);
    await runCatalogDelta('source-mirror-set', [original], '/', 'Set', 'mirror');
    await writeFixture('source-mirror-new/new.txt', 'new');
    upload.mockClear();
    trashDrive.mockClear();

    const res = await runCatalogDelta('source-mirror-set', [original, added], '/', 'Set', 'mirror');

    expect(res.newCount).toBe(1);
    expect(res.unchangedCount).toBe(10);
    expect(res.deletedCount).toBe(0);
    expect(trashDrive).not.toHaveBeenCalled();
  });
});

describe('runCatalogDelta — mirror deletion + safety gates', () => {
  // Seed a catalog without going through the recursive seed path's stat/readdir
  // (so the deletion-pass tests start from a known catalog independent of disk).
  // We do a real first run to seed, then mutate disk and re-run in mirror mode.
  async function seed(setId: string, srcDir: string) {
    return runCatalogDelta(setId, [srcDir], '/', 'Set', 'backup');
  }

  it('trashes a file that vanished locally (mirror)', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'm1');
    // Several files so removing one stays well under the 30% safety threshold.
    for (let i = 0; i < 10; i++) await writeFixture(`m1/f${i}.txt`, `data-${i}`);

    await seed('m1set', srcDir);
    trashDrive.mockClear();

    // Delete one local file → it becomes "stale" in the catalog next run.
    await fsp.rm(path.join(srcDir, 'f3.txt'));

    const res = await runCatalogDelta('m1set', [srcDir], '/', 'Set', 'mirror');

    expect(res.deletedCount).toBe(1);
    expect(trashDrive).toHaveBeenCalledTimes(1);
    // Trashed the right Drive path (normalized under /my-files).
    expect(trashDrive).toHaveBeenCalledWith('/my-files/Set/m1/f3.txt');
    expect(res.message).toContain('1 removed');
    // Catalog entry for the trashed file is dropped.
    expect(catalog.getFile('m1set', 'Set/m1/f3.txt')).toBeUndefined();
  });

  it('hard safety gate: skips deletion when a source is missing even if the percentage gate is disabled', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'm2');
    for (let i = 0; i < 10; i++) await writeFixture(`m2/f${i}.txt`, `data-${i}`);

    await seed('m2set', srcDir);
    trashDrive.mockClear();

    // Remove the ENTIRE source directory: every file is now "stale", but because the
    // configured source path itself is gone, the engine must NOT trash anything.
    await fsp.rm(srcDir, { recursive: true, force: true });
    setMirrorSafetyConfig({ enabled: false });

    const res = await runCatalogDelta('m2set', [srcDir], '/', 'Set', 'mirror');

    expect(trashDrive).not.toHaveBeenCalled();
    expect(res.deletedCount).toBe(0);
    expect(res.ok).toBe(false); // deletionSkipped makes the run not-ok
    expect(res.message).toContain('deletion skipped for safety');
    expect(res.message).toContain('missing on disk');
    // Nothing dropped from the catalog.
    expect(catalog.getFile('m2set', 'Set/m2/f0.txt')).toBeDefined();
  });

  it('safety gate: skips deletion when >30% of the catalog would be removed', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'm3');
    // 5 files seeded.
    for (let i = 0; i < 5; i++) await writeFixture(`m3/f${i}.txt`, `data-${i}`);

    await seed('m3set', srcDir);
    trashDrive.mockClear();

    // Delete 3 of 5 files (>30%) while keeping the source dir present (so gate #1
    // passes) and no upload failures (gate #2 passes) — only the percentage gate
    // should fire.
    await fsp.rm(path.join(srcDir, 'f0.txt'));
    await fsp.rm(path.join(srcDir, 'f1.txt'));
    await fsp.rm(path.join(srcDir, 'f2.txt'));

    const res = await runCatalogDelta('m3set', [srcDir], '/', 'Set', 'mirror');

    expect(trashDrive).not.toHaveBeenCalled();
    expect(res.deletedCount).toBe(0);
    expect(res.message).toContain('deletion skipped for safety');
    // The wording mentions the >30% bound.
    expect(res.message).toMatch(/would be removed|>30%/);
    // Surviving + removed catalog entries are all still present (nothing trashed).
    expect(catalog.getFile('m3set', 'Set/m3/f0.txt')).toBeDefined();
  });

  it('uses a custom global threshold for the live Mirror deletion pass', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'm-custom');
    for (let i = 0; i < 5; i++) await writeFixture(`m-custom/f${i}.txt`, `data-${i}`);
    await seed('m-custom-set', srcDir);
    trashDrive.mockClear();

    // Three missing file rows exceed the historical 30% threshold. Raising the
    // global threshold to 80% must permit this intentional deletion.
    await fsp.rm(path.join(srcDir, 'f0.txt'));
    await fsp.rm(path.join(srcDir, 'f1.txt'));
    await fsp.rm(path.join(srcDir, 'f2.txt'));
    setMirrorSafetyConfig({ enabled: true, deleteSafetyPct: 0.8 });

    const res = await runCatalogDelta('m-custom-set', [srcDir], '/', 'Set', 'mirror');

    expect(res.ok).toBe(true);
    expect(res.deletedCount).toBe(3);
    expect(trashDrive).toHaveBeenCalledTimes(3);
    expect(res.message).toContain('3 removed');
  });

  it('can disable only the percentage gate for an intentional full Mirror deletion', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'm-disabled');
    for (let i = 0; i < 5; i++) await writeFixture(`m-disabled/f${i}.txt`, `data-${i}`);
    await seed('m-disabled-set', srcDir);
    trashDrive.mockClear();

    for (let i = 0; i < 5; i++) await fsp.rm(path.join(srcDir, `f${i}.txt`));
    setMirrorSafetyConfig({ enabled: false });

    const res = await runCatalogDelta('m-disabled-set', [srcDir], '/', 'Set', 'mirror');

    expect(res.ok).toBe(true);
    expect(res.deletedCount).toBeGreaterThan(0);
    expect(trashDrive).toHaveBeenCalled();
    expect(catalog.count('m-disabled-set')).toBe(0);
  });

  it('backup mode never trashes, even when a file vanished locally', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'm4');
    for (let i = 0; i < 10; i++) await writeFixture(`m4/f${i}.txt`, `data-${i}`);

    await seed('m4set', srcDir);
    trashDrive.mockClear();

    await fsp.rm(path.join(srcDir, 'f2.txt'));

    const res = await runCatalogDelta('m4set', [srcDir], '/', 'Set', 'backup');

    expect(trashDrive).not.toHaveBeenCalled();
    expect(res.deletedCount).toBe(0);
    // The vanished file's catalog entry is NOT seen this run but backup never prunes.
    expect(catalog.getFile('m4set', 'Set/m4/f2.txt')).toBeDefined();
  });
});

describe('runCatalogDelta — auth + cancel handling', () => {
  it('stops with the reconnect message when an upload reports a dead session', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'auth1');
    await writeFixture('auth1/a.txt', 'aaa');
    // Seed first (seed path), then make the per-file upload fail with an auth error.
    await runCatalogDelta('authset', [srcDir], '/', 'Set', 'backup');

    // Add a new file so the second run has something to upload, then make upload
    // return an unauthenticated error (matches looksUnauthenticated → "no session").
    await writeFixture('auth1/b.txt', 'bbbb');
    upload.mockResolvedValue({ code: 1, stdout: '', stderr: 'Error: no session found' });

    const res = await runCatalogDelta('authset', [srcDir], '/', 'Set', 'backup');

    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Proton session expired/i);
  });

  it('returns a cancelled result when shouldCancel is set during the seed', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'cancel1');
    await writeFixture('cancel1/a.txt', 'aaa');

    // shouldCancel true from the start → the seed path's post-upload check returns
    // the cancelled result.
    const res = await runCatalogDelta(
      'cancelset',
      [srcDir],
      '/',
      'Set',
      'backup',
      [],
      () => {},
      () => {},
      () => true,
    );

    expect(res.cancelled).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Cancelled');
  });
});

describe('runCatalogDelta — excludes', () => {
  it('skips excluded files (and they force the per-file path, not the seed)', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'ex1');
    await writeFixture('ex1/keep.txt', 'keep');
    await writeFixture('ex1/skip.log', 'log');

    // excludes.length > 0 → seed path is skipped even with an empty catalog; the
    // engine runs the per-file diff and never uploads the excluded file.
    const res = await runCatalogDelta('exset', [srcDir], '/', 'Set', 'backup', ['*.log']);

    expect(res.newCount).toBe(1); // only keep.txt
    expect(catalog.getFile('exset', 'Set/ex1/keep.txt')).toBeDefined();
    expect(catalog.getFile('exset', 'Set/ex1/skip.log')).toBeUndefined();
  });
});

describe('previewDelta (dry run — read-only)', () => {
  it('first run (empty catalog): everything would upload, nothing unchanged/deleted', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'pv1');
    await writeFixture('pv1/a.txt', 'aaa');
    await writeFixture('pv1/sub/b.txt', 'bbbb');

    const p = await previewDelta('pvset1', [srcDir], 'Set', 'backup');

    expect(p.ok).toBe(true);
    expect(p.wouldUploadCount).toBe(2);
    expect(p.wouldUploadBytes).toBe(7); // 'aaa' (3) + 'bbbb' (4)
    expect(p.unchangedCount).toBe(0);
    expect(p.wouldDeleteCount).toBe(0);
    // Read-only: never touches Drive, never seeds the catalog.
    expect(upload).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
    expect(catalog.count('pvset1')).toBe(0);
  });

  it('after a real run with no changes: 0 to upload, all unchanged, catalog untouched', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'pv2');
    await writeFixture('pv2/a.txt', 'aaa');
    await writeFixture('pv2/b.txt', 'bbbb');
    await runCatalogDelta('pvset2', [srcDir], '/', 'Set', 'backup'); // seed
    const before = catalog.count('pvset2');
    upload.mockClear();

    const p = await previewDelta('pvset2', [srcDir], 'Set', 'backup');

    expect(p.wouldUploadCount).toBe(0);
    expect(p.unchangedCount).toBe(2);
    expect(upload).not.toHaveBeenCalled();
    expect(catalog.count('pvset2')).toBe(before); // unchanged
  });

  it('mirror: lists Drive items that vanished locally, without trashing anything', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'pv3');
    await writeFixture('pv3/a.txt', 'aaa');
    await writeFixture('pv3/b.txt', 'bbbb');
    await runCatalogDelta('pvset3', [srcDir], '/', 'Set', 'mirror'); // seed both

    await fsp.rm(path.join(LOCAL_ROOT, 'pv3/a.txt')); // a.txt gone locally
    trashDrive.mockClear();

    const p = await previewDelta('pvset3', [srcDir], 'Set', 'mirror');

    expect(p.wouldUploadCount).toBe(0);
    expect(p.unchangedCount).toBe(1); // b.txt
    expect(p.wouldDeleteCount).toBe(1);
    expect(p.wouldDelete).toContain('Set/pv3/a.txt');
    expect(p.deletionWouldSkip).toBeNull();
    // Still read-only: never trashes, catalog row for a.txt survives.
    expect(trashDrive).not.toHaveBeenCalled();
    expect(catalog.getFile('pvset3', 'Set/pv3/a.txt')).toBeDefined();
  });

  it('mirror: flags that the real run would SKIP deletion when a source is missing', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'pv4');
    await writeFixture('pv4/a.txt', 'aaa');
    await writeFixture('pv4/b.txt', 'bbbb');
    await runCatalogDelta('pvset4', [srcDir], '/', 'Set', 'mirror'); // seed

    await fsp.rm(srcDir, { recursive: true }); // the whole source mount vanished

    const p = await previewDelta('pvset4', [srcDir], 'Set', 'mirror');

    expect(p.deletionWouldSkip).toBeTruthy();
    expect(p.deletionWouldSkip).toMatch(/source path is missing/i);
  });

  it('mirror: uses the same custom or disabled percentage gate as a live run', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'pv-safety');
    for (let i = 0; i < 5; i++) await writeFixture(`pv-safety/f${i}.txt`, `data-${i}`);
    await runCatalogDelta('pv-safety-set', [srcDir], '/', 'Set', 'mirror');
    await fsp.rm(path.join(srcDir, 'f0.txt'));
    await fsp.rm(path.join(srcDir, 'f1.txt'));
    await fsp.rm(path.join(srcDir, 'f2.txt'));

    setMirrorSafetyConfig({ enabled: true, deleteSafetyPct: 0.2 });
    const blocked = await previewDelta('pv-safety-set', [srcDir], 'Set', 'mirror');
    expect(blocked.deletionWouldSkip).toMatch(/>20%/);

    setMirrorSafetyConfig({ enabled: true, deleteSafetyPct: 0.8 });
    const allowed = await previewDelta('pv-safety-set', [srcDir], 'Set', 'mirror');
    expect(allowed.deletionWouldSkip).toBeNull();
    expect(allowed.wouldDeleteCount).toBe(3);

    setMirrorSafetyConfig({ enabled: false });
    const disabled = await previewDelta('pv-safety-set', [srcDir], 'Set', 'mirror');
    expect(disabled.deletionWouldSkip).toBeNull();
    expect(trashDrive).not.toHaveBeenCalled();
  });

  it('backup mode never reports deletions', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'pv5');
    await writeFixture('pv5/a.txt', 'aaa');
    await runCatalogDelta('pvset5', [srcDir], '/', 'Set', 'backup');
    await fsp.rm(path.join(LOCAL_ROOT, 'pv5/a.txt')); // gone locally

    const p = await previewDelta('pvset5', [srcDir], 'Set', 'backup');

    expect(p.wouldDeleteCount).toBe(0);
    expect(p.deletionWouldSkip).toBeNull();
  });
});

describe('runCatalogDelta — per-file failure isolation (issue #22)', () => {
  it('isolates one poison file so its batch-mates still sync and only it fails', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'iso1');
    await writeFixture('iso1/good1.txt', 'a');
    await writeFixture('iso1/good2.txt', 'b');
    await writeFixture('iso1/bad [1080p].mkv', 'c');

    // Fail any upload whose batch includes the bracketed file; succeed otherwise.
    // (upload is mocked, so the real escapeGlobPath never runs here — this test
    // exercises the engine's ISOLATION independently of the cli.ts escaping fix.)
    upload.mockImplementation(async (absList: string[]) => {
      if (absList.some((p) => p.includes('bad ['))) return { code: 1, stdout: '', stderr: 'No paths matched' };
      return { code: 0, stdout: '', stderr: '' };
    });

    // excludes.length > 0 forces the per-file path (skips the recursive seed), so
    // every file flows through flush()/bisection. The pattern matches nothing real.
    const res = await runCatalogDelta('iso1set', [srcDir], '/', 'Set', 'backup', ['__none__']);

    expect(res.failedCount).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('1 failed');
    // The summary NAMES the offending file and gives a human reason, not just a count.
    expect(res.message).toContain('bad [1080p].mkv');
    expect(res.message).toMatch(/characters the Drive CLI cannot handle/);
    // …and the structured failedFiles list (persisted for the UI's skip panel) carries it.
    expect(res.failedFiles).toContainEqual({
      rel: 'Set/iso1/bad [1080p].mkv',
      reason: 'the name has characters the Drive CLI cannot handle',
    });
    // The two good files synced and are cataloged; the poison file is not.
    expect(catalog.getFile('iso1set', 'Set/iso1/good1.txt')).toBeDefined();
    expect(catalog.getFile('iso1set', 'Set/iso1/good2.txt')).toBeDefined();
    expect(catalog.getFile('iso1set', 'Set/iso1/bad [1080p].mkv')).toBeUndefined();
    // Bisection actually happened → more than one upload attempt.
    expect(upload.mock.calls.length).toBeGreaterThan(1);
  });

  it('a fully-good batch still uploads in ONE call (no bisection on the happy path)', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'iso2');
    await writeFixture('iso2/a.txt', 'aaa');
    await writeFixture('iso2/b.txt', 'bbb');

    const res = await runCatalogDelta('iso2set', [srcDir], '/', 'Set', 'backup', ['__none__']);

    expect(res.failedCount).toBe(0);
    expect(res.ok).toBe(true);
    // One bucket, one successful upload — no per-file slowdown when nothing fails.
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('includeHidden: dotfiles are skipped by default but backed up when the flag is set', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'hid');
    await writeFixture('hid/visible.txt', 'a');
    await writeFixture('hid/.secret', 'b');
    await writeFixture('hid/.config/app.conf', 'c');

    // Default (seed path): dotfiles and dot-directories are skipped.
    await runCatalogDelta('hidOff', [srcDir], '/', 'Set', 'backup');
    expect(catalog.getFile('hidOff', 'Set/hid/visible.txt')).toBeDefined();
    expect(catalog.getFile('hidOff', 'Set/hid/.secret')).toBeUndefined();
    expect(catalog.getFile('hidOff', 'Set/hid/.config/app.conf')).toBeUndefined();

    // includeHidden: the dotfile AND the file under the dot-directory are backed up.
    await runCatalogDelta('hidOn', [srcDir], '/', 'Set', 'backup', [], undefined, undefined, undefined, {
      includeHidden: true,
    });
    expect(catalog.getFile('hidOn', 'Set/hid/visible.txt')).toBeDefined();
    expect(catalog.getFile('hidOn', 'Set/hid/.secret')).toBeDefined();
    expect(catalog.getFile('hidOn', 'Set/hid/.config/app.conf')).toBeDefined();
  });

  it('mirror: a poison file keeps failedCount>0 so the deletion pass is skipped', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'iso3');
    for (let i = 0; i < 10; i++) await writeFixture(`iso3/f${i}.txt`, `data-${i}`);
    await runCatalogDelta('iso3set', [srcDir], '/', 'Set', 'backup'); // seed (all ok)
    upload.mockClear();
    trashDrive.mockClear();

    // f0 changes AND its upload fails; f1 vanishes locally (would be "stale").
    await writeFixture('iso3/f0.txt', 'grown-content-that-differs-in-size');
    await fsp.rm(path.join(srcDir, 'f1.txt'));
    upload.mockImplementation(async (absList: string[]) => {
      if (absList.some((p) => p.endsWith('f0.txt'))) return { code: 1, stdout: '', stderr: 'boom' };
      return { code: 0, stdout: '', stderr: '' };
    });
    setMirrorSafetyConfig({ enabled: false });

    const res = await runCatalogDelta('iso3set', [srcDir], '/', 'Set', 'mirror');

    expect(res.failedCount).toBe(1);
    // Hard safety gate #2 (an upload failed) remains active when the percentage
    // gate is disabled → deletion is skipped and nothing is trashed.
    expect(trashDrive).not.toHaveBeenCalled();
    expect(res.deletedCount).toBe(0);
    expect(res.message).toMatch(/failed to upload|deletion skipped/i);
    // The vanished file's catalog entry survives (never trashed/dropped).
    expect(catalog.getFile('iso3set', 'Set/iso3/f1.txt')).toBeDefined();
  });
});

// Memory-bounding behaviour (the 8 → 16 GiB OOM-kill loop). Two things the engine
// must do so one kill never becomes a daily kill:
//  (1) the recursive seed records the catalog PER completed unit (one CLI process per
//      top-level subtree), so a kill mid-seed leaves a non-empty catalog and the next
//      run resumes per file instead of re-running the whole seed;
//  (2) pending upload buckets are capped in TOTAL, so a tree of many small folders
//      (none ever reaching CHUNK) can't hold every new file in memory until the walk ends.
describe('runCatalogDelta — bounded memory (seed resumability + pending cap)', () => {
  it('seed: one CLI process per top-level subtree, catalog recorded after each one', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'seedu');
    await writeFixture('seedu/d1/a.txt', 'aaa');
    await writeFixture('seedu/d2/b.txt', 'bbb');

    // Fail the SECOND directory unit (whichever order readdir yields them in).
    let dirUnits = 0;
    upload.mockImplementation(async (absList: string[]) => {
      if (absList.length === 1 && /[/\\]d[12]$/.test(absList[0])) {
        dirUnits += 1;
        if (dirUnits === 2) return { code: 1, stdout: '', stderr: 'boom' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const first = await runCatalogDelta('seedu-set', [srcDir], '/', 'Set', 'backup');
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/Initial upload failed/);
    // Each subtree was its own upload call (not one call with both children)…
    expect(dirUnits).toBe(2);
    // …and the one that completed is already in the catalog despite the failure.
    const a = catalog.getFile('seedu-set', 'Set/seedu/d1/a.txt');
    const b = catalog.getFile('seedu-set', 'Set/seedu/d2/b.txt');
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(first.newCount).toBe(1);

    // Next run: catalog is non-empty → per-file path, which uploads ONLY the
    // subtree that was still missing — no second recursive seed of everything.
    upload.mockClear();
    upload.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const second = await runCatalogDelta('seedu-set', [srcDir], '/', 'Set', 'backup');
    expect(second.ok).toBe(true);
    expect(second.newCount).toBe(1);
    expect(second.unchangedCount).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
    const uploadedAbs = upload.mock.calls[0][0];
    expect(uploadedAbs).toHaveLength(1);
    expect(uploadedAbs[0]).toMatch(a ? /d2[/\\]b\.txt$/ : /d1[/\\]a\.txt$/);
  });

  it('pending cap: flushes mid-walk once the total queued across buckets hits the cap', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'pcap');
    // 3 folders × 2 files: no bucket ever reaches CHUNK (200), so without a total cap
    // nothing would be flushed until the walk is over.
    for (const d of ['x', 'y', 'z']) {
      await writeFixture(`pcap/${d}/f1.txt`, 'a');
      await writeFixture(`pcap/${d}/f2.txt`, 'b');
    }
    // Count how many files the walk had stat'ed when the FIRST upload started (the
    // walk stats the source root once, then one stat per file; nothing else in the
    // per-file path stats before the first flush).
    const statSpy = vi.spyOn(fsp, 'stat');
    let statsAtFirstUpload = -1;
    upload.mockImplementation(async () => {
      if (statsAtFirstUpload < 0) statsAtFirstUpload = statSpy.mock.calls.length;
      return { code: 0, stdout: '', stderr: '' };
    });

    process.env.PDB_PENDING_CAP = '3';
    try {
      // excludes.length > 0 forces the per-file path (not the recursive seed).
      const res = await runCatalogDelta('pcap-set', [srcDir], '/', 'Set', 'backup', ['__none__']);
      expect(res.ok).toBe(true);
      expect(res.newCount).toBe(6);
    } finally {
      delete process.env.PDB_PENDING_CAP;
      statSpy.mockRestore();
    }
    // Flushed while the walk was still in progress (root + 3 files stat'ed), not only
    // after all 6 files (root + 6 stats) were walked.
    expect(statsAtFirstUpload).toBeGreaterThanOrEqual(1);
    expect(statsAtFirstUpload).toBeLessThanOrEqual(4);
    // Every file still made it into the catalog exactly once.
    for (const d of ['x', 'y', 'z']) {
      expect(catalog.getFile('pcap-set', `Set/pcap/${d}/f1.txt`)).toBeDefined();
      expect(catalog.getFile('pcap-set', `Set/pcap/${d}/f2.txt`)).toBeDefined();
    }
  });
});

// Scale hazards found in the Oct 2026 review: the top-most computation of the mirror
// deletion pass / dry-run was O(n²) over stale entries, and every direct child file of
// a source folder went into ONE argv (E2BIG for folders with tens of thousands of files).
describe('runCatalogDelta — scale: top-most deletion set and argv-sized file units', () => {
  it('mirror: trashes a vanished folder ONCE (not each child) and drops all its catalog rows', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'tops');
    for (let i = 0; i < 8; i++) await writeFixture(`tops/keep/f${i}.txt`, `k${i}`);
    await writeFixture('tops/gone/a.txt', 'a');
    await writeFixture('tops/gone/deep/b.txt', 'b');
    await runCatalogDelta('tops-set', [srcDir], '/', 'Set', 'backup'); // seed
    trashDrive.mockClear();

    // 4 stale rows (gone, gone/a.txt, gone/deep, gone/deep/b.txt) of ~14 → under 30%.
    await fsp.rm(path.join(srcDir, 'gone'), { recursive: true });
    const res = await runCatalogDelta('tops-set', [srcDir], '/', 'Set', 'mirror');

    expect(res.ok).toBe(true);
    expect(trashDrive).toHaveBeenCalledTimes(1);
    expect(trashDrive).toHaveBeenCalledWith('/my-files/Set/tops/gone');
    expect(res.deletedCount).toBe(1);
    expect(catalog.hasDir('tops-set', 'Set/tops/gone')).toBe(false);
    expect(catalog.getFile('tops-set', 'Set/tops/gone/a.txt')).toBeUndefined();
    expect(catalog.getFile('tops-set', 'Set/tops/gone/deep/b.txt')).toBeUndefined();
    expect(catalog.getFile('tops-set', 'Set/tops/keep/f0.txt')).toBeDefined();

    // The dry-run reports the same single top-most path.
    await fsp.rm(path.join(srcDir, 'keep', 'f7.txt'));
    const p = await previewDelta('tops-set', [srcDir], 'Set', 'mirror');
    expect(p.wouldDelete).toEqual(['Set/tops/keep/f7.txt']);
  });

  it('topMost: O(n·depth) on a large stale set, same answer as the pairwise definition', async () => {
    const { topMost } = await import('@/server/engine');
    const entries: { rel: string }[] = [];
    for (let d = 0; d < 200; d++) {
      entries.push({ rel: `S/y/${d}` });
      for (let f = 0; f < 50; f++) entries.push({ rel: `S/y/${d}/f${f}` });
    }
    entries.push({ rel: 'S/z/lonely.txt' }); // no ancestor in the set → top-most itself
    const t0 = Date.now();
    const tops = topMost(entries);
    expect(Date.now() - t0).toBeLessThan(1000); // 10k entries; the O(n²) version took ~seconds+
    expect(tops).toHaveLength(201);
    expect(tops.map((e) => e.rel)).toContain('S/z/lonely.txt');
    expect(tops.some((e) => e.rel.startsWith('S/y/0/'))).toBe(false);
  });

  it('seed: a folder with many direct files is uploaded in argv-sized chunks, all cataloged', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'flat');
    const N = 1100; // > 2 × FILE_UNIT_CHUNK (500)
    await fsp.mkdir(srcDir, { recursive: true });
    await Promise.all(Array.from({ length: N }, (_, i) => fsp.writeFile(path.join(srcDir, `f${i}.txt`), 'x')));

    const res = await runCatalogDelta('flat-set', [srcDir], '/', 'Set', 'backup');

    expect(res.ok).toBe(true);
    expect(res.newCount).toBe(N);
    expect(upload).toHaveBeenCalledTimes(3); // 500 + 500 + 100
    for (const call of upload.mock.calls) expect(call[0].length).toBeLessThanOrEqual(500);
    expect(catalog.count('flat-set')).toBeGreaterThanOrEqual(N);
  });
});
