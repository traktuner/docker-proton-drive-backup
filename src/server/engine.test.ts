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
import { relBaseFor, runCatalogDelta } from '@/server/engine';
import * as cli from '@/server/cli';
import { catalog } from '@/server/catalog';
import { LOCAL_ROOT } from '@/server/local';
import { getDb } from '@/server/db';

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

  it('safety gate: skips deletion entirely when a source path is missing on disk', async () => {
    const srcDir = path.join(LOCAL_ROOT, 'm2');
    for (let i = 0; i < 10; i++) await writeFixture(`m2/f${i}.txt`, `data-${i}`);

    await seed('m2set', srcDir);
    trashDrive.mockClear();

    // Remove the ENTIRE source directory: every file is now "stale", but because the
    // configured source path itself is gone, the engine must NOT trash anything.
    await fsp.rm(srcDir, { recursive: true, force: true });

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
