import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { backupSets, getDb, healDoubledSourcePaths } from '@/server/db';
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
    expect(s.watch).toBe(false);
    expect(s.targetSubfolder).toBe('Photos');
    expect(s.lastStatus).toBe('never');
    expect(backupSets.get(s.id)?.name).toBe('Photos');
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
