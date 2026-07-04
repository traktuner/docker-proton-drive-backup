import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { backupSets, getDb, healDoubledSourcePaths } from '@/server/db';
import { catalog } from '@/server/catalog';
import { LOCAL_ROOT } from '@/server/local';

beforeEach(() => {
  getDb().exec('DELETE FROM backup_sets');
});

describe('backupSets store', () => {
  it('creates a set with sane defaults (incl. migrated columns)', () => {
    const s = backupSets.create({ name: 'Photos', sourcePaths: ['/sources/photos'], targetPath: '/' });
    expect(s.mode).toBe('add');
    expect(s.schedule).toBe('off');
    expect(s.skipThumbnails).toBe(false);
    expect(s.includeHidden).toBe(false);
    expect(s.watch).toBe(false);
    expect(s.targetSubfolder).toBe('Photos');
    expect(s.lastStatus).toBe('never');
    expect(backupSets.get(s.id)?.name).toBe('Photos');
  });

  it('persists includeHidden through create + update', () => {
    const s = backupSets.create({ name: 'Hid', sourcePaths: ['/x'], targetPath: '/', includeHidden: true });
    expect(s.includeHidden).toBe(true);
    backupSets.update(s.id, { includeHidden: false });
    expect(backupSets.get(s.id)!.includeHidden).toBe(false);
  });

  // Regression: an existing user's row predates the include_hidden column. The
  // NOT NULL DEFAULT 0 migration must let it read back unchanged (hidden off), so
  // existing backups behave EXACTLY as before — nothing suddenly starts/stops.
  it('a legacy row written without the new columns reads includeHidden=false (migration-safe)', () => {
    getDb()
      .prepare(
        `INSERT INTO backup_sets (id, name, source_paths, target_path, mode, schedule, last_status, created_at)
         VALUES ('legacy1', 'Legacy', '["/sources/x"]', '/', 'backup', 'daily', 'success', 1)`,
      )
      .run();
    const s = backupSets.get('legacy1')!;
    expect(s).toBeDefined();
    expect(s.name).toBe('Legacy');
    expect(s.mode).toBe('backup');
    expect(s.schedule).toBe('daily');
    expect(s.includeHidden).toBe(false); // old behaviour preserved: dotfiles still skipped
    expect(s.skipThumbnails).toBe(false);
    expect(s.sourcePaths).toEqual(['/sources/x']);
  });

  it('makes the subfolder unique per target', () => {
    backupSets.create({ name: 'Photos', sourcePaths: ['/x'], targetPath: '/' });
    const b = backupSets.create({ name: 'Photos', sourcePaths: ['/y'], targetPath: '/' });
    expect(b.targetSubfolder).toBe('Photos-2');
    // different target → no clash
    const c = backupSets.create({ name: 'Photos', sourcePaths: ['/z'], targetPath: '/other' });
    expect(c.targetSubfolder).toBe('Photos');
  });

  it('persists skipThumbnails / watch through update', () => {
    const s = backupSets.create({ name: 'A', sourcePaths: ['/x'], targetPath: '/' });
    backupSets.update(s.id, { skipThumbnails: true, watch: true, name: 'A renamed' });
    const got = backupSets.get(s.id)!;
    expect(got.skipThumbnails).toBe(true);
    expect(got.watch).toBe(true);
    expect(got.name).toBe('A renamed');
    // rename keeps the Drive subfolder stable (no re-upload)
    expect(got.targetSubfolder).toBe('A');
  });

  it('updateStatus + markInterrupted behave', () => {
    const s = backupSets.create({ name: 'B', sourcePaths: ['/x'], targetPath: '/' });
    backupSets.updateStatus(s.id, 'running', 'Starting…', true);
    expect(backupSets.get(s.id)?.lastStatus).toBe('running');
    backupSets.markInterrupted(s.id);
    const got = backupSets.get(s.id)!;
    expect(got.lastStatus).toBe('cancelled');
    expect(got.lastRunAt).toBeNull(); // cleared so the scheduler retries the slot
  });

  it('deletes a set', () => {
    const s = backupSets.create({ name: 'C', sourcePaths: ['/x'], targetPath: '/' });
    backupSets.delete(s.id);
    expect(backupSets.get(s.id)).toBeNull();
  });
});

describe('healDoubledSourcePaths (recovery for the edit-route doubling bug)', () => {
  // The doubling resolveLocal produced for an already-absolute path: it joins
  // LOCAL_ROOT onto a path that already starts with LOCAL_ROOT, so the prefix
  // repeats — "/sources/Photos" → "/sources/sources/Photos".
  const correct = path.join(LOCAL_ROOT, 'Photos');
  const doubled = LOCAL_ROOT + LOCAL_ROOT + '/Photos';
  const tripled = LOCAL_ROOT + LOCAL_ROOT + LOCAL_ROOT + '/Photos';

  beforeEach(() => {
    fs.mkdirSync(correct, { recursive: true });
  });

  it('repairs a doubled source path when the real folder exists', () => {
    const s = backupSets.create({ name: 'Photos', sourcePaths: [doubled], targetPath: '/' });
    healDoubledSourcePaths();
    expect(backupSets.get(s.id)!.sourcePaths).toEqual([correct]);
  });

  it('repairs a path doubled more than once', () => {
    const s = backupSets.create({ name: 'Photos', sourcePaths: [tripled], targetPath: '/' });
    healDoubledSourcePaths();
    expect(backupSets.get(s.id)!.sourcePaths).toEqual([correct]);
  });

  it('leaves a correct, existing source path untouched', () => {
    const s = backupSets.create({ name: 'Photos', sourcePaths: [correct], targetPath: '/' });
    healDoubledSourcePaths();
    expect(backupSets.get(s.id)!.sourcePaths).toEqual([correct]);
  });

  it('does NOT heal when the de-doubled path does not exist (e.g. offline mount)', () => {
    const missingDoubled = LOCAL_ROOT + LOCAL_ROOT + '/NotMounted';
    const s = backupSets.create({ name: 'X', sourcePaths: [missingDoubled], targetPath: '/' });
    healDoubledSourcePaths();
    // Can't trust "gone locally" → leave it exactly as stored.
    expect(backupSets.get(s.id)!.sourcePaths).toEqual([missingDoubled]);
  });

  it('does NOT touch a real folder that happens to look doubled (stored path exists)', () => {
    // Pathological but real: BOTH "<root>/Deep" and the look-doubled
    // "<root><root>/Deep" exist on disk. Since the stored path itself exists, the
    // `!exists(stored)` guard must refuse to rewrite it — no data points the wrong way.
    fs.mkdirSync(path.join(LOCAL_ROOT, 'Deep'), { recursive: true });
    const realNested = LOCAL_ROOT + LOCAL_ROOT + '/Deep';
    fs.mkdirSync(realNested, { recursive: true });
    const s = backupSets.create({ name: 'Nested', sourcePaths: [realNested], targetPath: '/' });
    healDoubledSourcePaths();
    expect(backupSets.get(s.id)!.sourcePaths).toEqual([realNested]);
  });
});

describe('renameSubfolder (#16 — rewrite catalog keys so a folder rename re-uploads nothing)', () => {
  beforeEach(() => {
    catalog.count('__warm__'); // ensure the catalog table exists
    getDb().exec('DELETE FROM backup_catalog');
  });

  it('rewrites the bare dir row and every "<old>/…" file+dir row, and the stored subfolder', () => {
    const s = backupSets.create({ name: 'Photos', sourcePaths: ['/x'], targetPath: '/' });
    const t = 1_000;
    catalog.upsertDir(s.id, 'Photos', t);
    catalog.upsertDir(s.id, 'Photos/sub', t);
    catalog.upsertFile(s.id, 'Photos/a.txt', 3, t, null, t);
    catalog.upsertFile(s.id, 'Photos/sub/b.txt', 4, t, null, t);

    backupSets.renameSubfolder(s.id, 'Photos', 'Album');

    expect(backupSets.get(s.id)!.targetSubfolder).toBe('Album');
    expect(catalog.hasDir(s.id, 'Album')).toBe(true);
    expect(catalog.hasDir(s.id, 'Album/sub')).toBe(true);
    expect(catalog.getFile(s.id, 'Album/a.txt')).toBeDefined();
    expect(catalog.getFile(s.id, 'Album/sub/b.txt')).toBeDefined();
    // Nothing left under the old prefix.
    expect(catalog.hasDir(s.id, 'Photos')).toBe(false);
    expect(catalog.getFile(s.id, 'Photos/a.txt')).toBeUndefined();
  });

  it('does not touch another set sharing the same catalog table', () => {
    const a = backupSets.create({ name: 'A', sourcePaths: ['/x'], targetPath: '/' });
    const b = backupSets.create({ name: 'B', sourcePaths: ['/y'], targetPath: '/' });
    const t = 1_000;
    catalog.upsertFile(a.id, 'A/f.txt', 1, t, null, t);
    catalog.upsertFile(b.id, 'A/f.txt', 1, t, null, t); // same rel string, different set

    backupSets.renameSubfolder(a.id, 'A', 'A2');

    expect(catalog.getFile(a.id, 'A2/f.txt')).toBeDefined();
    expect(catalog.getFile(a.id, 'A/f.txt')).toBeUndefined();
    expect(catalog.getFile(b.id, 'A/f.txt')).toBeDefined(); // B untouched
  });

  it('escapes LIKE metacharacters so a "_"/"%" in the old name cannot widen the match', () => {
    const s = backupSets.create({ name: 'us', sourcePaths: ['/x'], targetPath: '/' });
    const t = 1_000;
    catalog.upsertFile(s.id, 'a_b/keep.txt', 1, t, null, t); // belongs to the renamed folder
    catalog.upsertFile(s.id, 'aXb/other.txt', 1, t, null, t); // '_' as wildcard would wrongly match this

    backupSets.renameSubfolder(s.id, 'a_b', 'a_b-renamed');

    expect(catalog.getFile(s.id, 'a_b-renamed/keep.txt')).toBeDefined();
    expect(catalog.getFile(s.id, 'aXb/other.txt')).toBeDefined(); // NOT rewritten
  });
});
