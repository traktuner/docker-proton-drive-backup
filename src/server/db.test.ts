import { describe, it, expect, beforeEach } from 'vitest';
import { backupSets, getDb } from '@/server/db';

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
