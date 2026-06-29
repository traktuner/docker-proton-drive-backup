import { describe, it, expect, beforeEach } from 'vitest';
import { catalog, diffFile, type CatalogFile } from '@/server/catalog';
import { getDb } from '@/server/db';

const SET = 'set-A';
const OTHER = 'set-B';

// Touching the catalog API lazily creates the `backup_catalog` table the first
// time any statement runs. Calling count() here guarantees the table exists so
// the DELETE in beforeEach never fails on the very first test file run.
catalog.count(SET);

beforeEach(() => {
  getDb().exec('DELETE FROM backup_catalog');
});

describe('catalog.upsertFile / getFile round-trip', () => {
  it('stores and reads back size, mtimeMs, sha1', () => {
    catalog.upsertFile(SET, 'a/b.txt', 1234, 1000, 'deadbeef', 5000);
    const f = catalog.getFile(SET, 'a/b.txt');
    expect(f).toEqual<CatalogFile>({ size: 1234, mtimeMs: 1000, sha1: 'deadbeef' });
  });

  it('returns undefined for a missing file', () => {
    expect(catalog.getFile(SET, 'nope.txt')).toBeUndefined();
  });

  it('keeps a null sha1 as null', () => {
    catalog.upsertFile(SET, 'x.bin', 10, 20, null, 30);
    expect(catalog.getFile(SET, 'x.bin')).toEqual({ size: 10, mtimeMs: 20, sha1: null });
  });

  it('upsert overwrites the existing row (same set_id/rel) in place', () => {
    catalog.upsertFile(SET, 'f', 1, 1, 'aaa', 100);
    catalog.upsertFile(SET, 'f', 2, 22, 'bbb', 200);
    expect(catalog.getFile(SET, 'f')).toEqual({ size: 2, mtimeMs: 22, sha1: 'bbb' });
    // still exactly one row for the set
    expect(catalog.count(SET)).toBe(1);
  });

  it('is scoped per set_id (same rel in two sets is independent)', () => {
    catalog.upsertFile(SET, 'shared', 1, 1, 'a', 100);
    catalog.upsertFile(OTHER, 'shared', 9, 9, 'z', 100);
    expect(catalog.getFile(SET, 'shared')).toEqual({ size: 1, mtimeMs: 1, sha1: 'a' });
    expect(catalog.getFile(OTHER, 'shared')).toEqual({ size: 9, mtimeMs: 9, sha1: 'z' });
  });

  it('getFile only returns rows of kind=file, not dirs', () => {
    catalog.upsertDir(SET, 'somedir', 100);
    expect(catalog.getFile(SET, 'somedir')).toBeUndefined();
  });
});

describe('diffFile', () => {
  const cat: CatalogFile = { size: 1000, mtimeMs: 50_000, sha1: 'h' };

  it("returns 'new' when there is no catalog entry", () => {
    expect(diffFile({ size: 1000, mtimeMs: 50_000 }, undefined)).toBe('new');
  });

  it("returns 'unchanged' when size matches and mtime is identical", () => {
    expect(diffFile({ size: 1000, mtimeMs: 50_000 }, cat)).toBe('unchanged');
  });

  it("returns 'unchanged' when size matches and mtime drift is within 2000ms (inclusive)", () => {
    expect(diffFile({ size: 1000, mtimeMs: 52_000 }, cat)).toBe('unchanged'); // +2000 boundary
    expect(diffFile({ size: 1000, mtimeMs: 48_000 }, cat)).toBe('unchanged'); // -2000 boundary
    expect(diffFile({ size: 1000, mtimeMs: 51_999 }, cat)).toBe('unchanged');
  });

  it("returns 'changed' whenever the size differs (regardless of mtime)", () => {
    expect(diffFile({ size: 1001, mtimeMs: 50_000 }, cat)).toBe('changed');
    expect(diffFile({ size: 999, mtimeMs: 50_000 }, cat)).toBe('changed');
    // size wins over an otherwise-'hash'-worthy mtime drift
    expect(diffFile({ size: 1001, mtimeMs: 999_999 }, cat)).toBe('changed');
  });

  it("returns 'hash' when size matches but mtime drift exceeds 2000ms", () => {
    expect(diffFile({ size: 1000, mtimeMs: 52_001 }, cat)).toBe('hash'); // just over +2000
    expect(diffFile({ size: 1000, mtimeMs: 47_999 }, cat)).toBe('hash'); // just over -2000
    expect(diffFile({ size: 1000, mtimeMs: 999_999 }, cat)).toBe('hash');
  });
});

describe('catalog.count / clear', () => {
  it('counts rows for a set (files and dirs both count)', () => {
    expect(catalog.count(SET)).toBe(0);
    catalog.upsertFile(SET, 'a', 1, 1, null, 1);
    catalog.upsertFile(SET, 'b', 1, 1, null, 1);
    catalog.upsertDir(SET, 'd', 1);
    expect(catalog.count(SET)).toBe(3);
  });

  it('clear removes only the target set, leaving other sets intact', () => {
    catalog.upsertFile(SET, 'a', 1, 1, null, 1);
    catalog.upsertFile(OTHER, 'a', 1, 1, null, 1);
    catalog.clear(SET);
    expect(catalog.count(SET)).toBe(0);
    expect(catalog.count(OTHER)).toBe(1);
  });
});

describe('catalog.upsertDir / hasDir', () => {
  it('records a dir and hasDir reports it', () => {
    expect(catalog.hasDir(SET, 'photos')).toBe(false);
    catalog.upsertDir(SET, 'photos', 100);
    expect(catalog.hasDir(SET, 'photos')).toBe(true);
  });

  it('hasDir is false for a file rel of the same name', () => {
    catalog.upsertFile(SET, 'thing', 1, 1, null, 1);
    expect(catalog.hasDir(SET, 'thing')).toBe(false);
  });

  it('re-upserting a dir just bumps seen_at (no duplicate row)', () => {
    catalog.upsertDir(SET, 'photos', 100);
    catalog.upsertDir(SET, 'photos', 200);
    expect(catalog.count(SET)).toBe(1);
    // bumped seen_at means it is no longer stale before 150
    expect(catalog.stale(SET, 150)).toEqual([]);
  });
});

describe('catalog mirror staleness (touch / touchMany / stale)', () => {
  const OLD = 1000;
  const NEW = 2000;

  function seedOld() {
    catalog.upsertFile(SET, 'keep1.txt', 1, 1, null, OLD);
    catalog.upsertFile(SET, 'keep2.txt', 1, 1, null, OLD);
    catalog.upsertFile(SET, 'gone1.txt', 1, 1, null, OLD);
    catalog.upsertFile(SET, 'gone2.txt', 1, 1, null, OLD);
    catalog.upsertDir(SET, 'dir', OLD);
  }

  it('stale() returns rows whose seen_at is strictly < the cutoff', () => {
    seedOld();
    // touch the "keep" subset + the dir to the new run timestamp
    catalog.touchMany(SET, ['keep1.txt', 'keep2.txt', 'dir'], NEW);

    const stale = catalog.stale(SET, NEW);
    const rels = stale.map((r) => r.rel).sort();
    expect(rels).toEqual(['gone1.txt', 'gone2.txt']);
  });

  it('touched-this-run rows (seen_at == cutoff) are NOT stale', () => {
    seedOld();
    catalog.touchMany(SET, ['keep1.txt'], NEW);
    const staleRels = catalog.stale(SET, NEW).map((r) => r.rel);
    expect(staleRels).not.toContain('keep1.txt');
  });

  it('touchMany with a single rel updates just that row', () => {
    seedOld();
    catalog.touchMany(SET, ['gone1.txt'], NEW);
    const staleRels = catalog.stale(SET, NEW).map((r) => r.rel).sort();
    // gone1 was bumped; every other un-touched row (incl. the seeded dir) is stale
    expect(staleRels).toEqual(['dir', 'gone2.txt', 'keep1.txt', 'keep2.txt']);
  });

  it('reports kind for stale rows (file vs dir)', () => {
    catalog.upsertFile(SET, 'f.txt', 1, 1, null, OLD);
    catalog.upsertDir(SET, 'd', OLD);
    const stale = catalog.stale(SET, NEW);
    const byRel = Object.fromEntries(stale.map((r) => [r.rel, r.kind]));
    expect(byRel['f.txt']).toBe('file');
    expect(byRel['d']).toBe('dir');
  });

  it('stale ordering is by rel length (shorter/shallower first)', () => {
    catalog.upsertFile(SET, 'aa', 1, 1, null, OLD);
    catalog.upsertFile(SET, 'aaaa', 1, 1, null, OLD);
    catalog.upsertFile(SET, 'a', 1, 1, null, OLD);
    const order = catalog.stale(SET, NEW).map((r) => r.rel);
    expect(order).toEqual(['a', 'aa', 'aaaa']);
  });

  it('staleness is per-set (other set untouched is unaffected)', () => {
    catalog.upsertFile(SET, 'x', 1, 1, null, OLD);
    catalog.upsertFile(OTHER, 'x', 1, 1, null, NEW);
    expect(catalog.stale(SET, NEW).map((r) => r.rel)).toEqual(['x']);
    expect(catalog.stale(OTHER, NEW)).toEqual([]);
  });
});

describe('catalog.remove', () => {
  it('drops exactly the given rels and leaves the rest', () => {
    catalog.upsertFile(SET, 'a', 1, 1, null, 1);
    catalog.upsertFile(SET, 'b', 1, 1, null, 1);
    catalog.upsertFile(SET, 'c', 1, 1, null, 1);
    catalog.remove(SET, ['a', 'c']);
    expect(catalog.getFile(SET, 'a')).toBeUndefined();
    expect(catalog.getFile(SET, 'c')).toBeUndefined();
    expect(catalog.getFile(SET, 'b')).toBeTruthy();
    expect(catalog.count(SET)).toBe(1);
  });

  it('removes dirs too and tolerates an empty list', () => {
    catalog.upsertDir(SET, 'd', 1);
    catalog.remove(SET, []);
    expect(catalog.hasDir(SET, 'd')).toBe(true);
    catalog.remove(SET, ['d']);
    expect(catalog.hasDir(SET, 'd')).toBe(false);
  });

  it('only removes from the named set', () => {
    catalog.upsertFile(SET, 'a', 1, 1, null, 1);
    catalog.upsertFile(OTHER, 'a', 1, 1, null, 1);
    catalog.remove(SET, ['a']);
    expect(catalog.getFile(SET, 'a')).toBeUndefined();
    expect(catalog.getFile(OTHER, 'a')).toBeTruthy();
  });
});

describe('catalog.eachFile / batch', () => {
  it('eachFile streams every file row (rel/size/sha1) but skips dirs', () => {
    catalog.upsertFile(SET, 'a', 10, 1, 'ha', 1);
    catalog.upsertFile(SET, 'b', 20, 1, null, 1);
    catalog.upsertDir(SET, 'd', 1);
    const seen: Record<string, { size: number; sha1: string | null }> = {};
    catalog.eachFile(SET, (f) => {
      seen[f.rel] = { size: f.size, sha1: f.sha1 };
    });
    expect(seen).toEqual({
      a: { size: 10, sha1: 'ha' },
      b: { size: 20, sha1: null },
    });
  });

  it('batch runs the writes in one transaction and they persist', () => {
    catalog.batch(() => {
      catalog.upsertFile(SET, 'a', 1, 1, null, 1);
      catalog.upsertFile(SET, 'b', 1, 1, null, 1);
    });
    expect(catalog.count(SET)).toBe(2);
  });
});
