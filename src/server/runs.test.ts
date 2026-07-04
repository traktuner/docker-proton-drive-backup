import { describe, it, expect } from 'vitest';
import { runs } from '@/server/runs';
import { getDb } from '@/server/db';

// Each test uses a distinct set_id so the shared per-file DB never cross-contaminates.

describe('runs history', () => {
  it('records and reads back a run WITH its skipped files (issue #22 UI panel)', () => {
    runs.record('set1', {
      startedAt: 1,
      finishedAt: 2,
      status: 'error',
      message: '3 uploaded, 1 skipped',
      files: 3,
      bytes: 100,
      skipped: [{ rel: 'Set/A/bad.txt', reason: 'name too long (Proton Drive allows at most 255 characters)' }],
    });
    const r = runs.recent('set1');
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe('error');
    expect(r[0].files).toBe(3);
    expect(r[0].skipped).toEqual([
      { rel: 'Set/A/bad.txt', reason: 'name too long (Proton Drive allows at most 255 characters)' },
    ]);
  });

  it('reads back an empty skipped list for a clean run', () => {
    runs.record('set2', { startedAt: 1, finishedAt: 2, status: 'success', message: 'ok', files: 1, bytes: 1, skipped: [] });
    expect(runs.recent('set2')[0].skipped).toEqual([]);
  });

  // Regression: a run row written before the `skipped` column existed reads back as
  // NULL. It must degrade to an empty list, never crash — existing history stays valid.
  it('reads a NULL skipped column (pre-migration row) as an empty list', () => {
    // A prior runs.* call already ran the additive ALTER, so the column exists; insert
    // a row that omits it (as an old build would) → stored NULL.
    runs.record('warm', { startedAt: 0, finishedAt: 0, status: 'success', message: 'x', files: 0, bytes: 0, skipped: [] });
    getDb()
      .prepare(
        `INSERT INTO backup_runs (set_id, started_at, finished_at, status, message, files, bytes)
         VALUES ('legacy', 10, 20, 'error', 'boom', 0, 0)`,
      )
      .run();
    const r = runs.recent('legacy');
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe('error');
    expect(r[0].skipped).toEqual([]);
  });

  it('is resilient to a malformed skipped JSON blob', () => {
    runs.record('warm2', { startedAt: 0, finishedAt: 0, status: 'success', message: 'x', files: 0, bytes: 0, skipped: [] });
    getDb()
      .prepare(
        `INSERT INTO backup_runs (set_id, started_at, finished_at, status, message, files, bytes, skipped)
         VALUES ('bad', 1, 2, 'success', 'ok', 0, 0, 'not json')`,
      )
      .run();
    expect(runs.recent('bad')[0].skipped).toEqual([]);
  });

  it('keeps only the 50 most recent runs per set (newest first)', () => {
    for (let i = 0; i < 55; i++) {
      runs.record('cap', { startedAt: i, finishedAt: i, status: 'success', message: String(i), files: 0, bytes: 0, skipped: [] });
    }
    const r = runs.recent('cap', 100);
    expect(r).toHaveLength(50);
    expect(r[0].message).toBe('54'); // newest first
    expect(r[49].message).toBe('5'); // 0-4 were pruned
  });

  it('lastSuccessAt returns the latest successful finish, else null', () => {
    runs.record('ls', { startedAt: 1, finishedAt: 100, status: 'success', message: 'ok', files: 0, bytes: 0, skipped: [] });
    runs.record('ls', { startedAt: 2, finishedAt: 200, status: 'error', message: 'no', files: 0, bytes: 0, skipped: [] });
    expect(runs.lastSuccessAt('ls')).toBe(100);
    expect(runs.lastSuccessAt('never-ran')).toBeNull();
  });

  it('clear removes a set’s history', () => {
    runs.record('c', { startedAt: 1, finishedAt: 2, status: 'success', message: 'ok', files: 0, bytes: 0, skipped: [] });
    runs.clear('c');
    expect(runs.recent('c')).toEqual([]);
  });
});
