import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { DELETE, PATCH } from '@/app/api/backup-sets/[id]/route';
import { backupSets, getDb } from '@/server/db';
import { catalog } from '@/server/catalog';
import { LOCAL_ROOT } from '@/server/local';
import { claimBackupSet, isBackupSetBusy, releaseBackupSet } from '@/server/backup-lock';

function createSource(name: string): string {
  const source = path.join(LOCAL_ROOT, name);
  fs.mkdirSync(source, { recursive: true });
  return source;
}

function addRequest(id: string, sourcePaths: unknown[], excludes: string[] = []) {
  return POST(
    new Request(`http://localhost/api/backup-sets/${id}/source-paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePaths, excludes }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  catalog.count('__warm__');
  getDb().exec('DELETE FROM backup_catalog; DELETE FROM backup_sets;');
});

describe('POST /api/backup-sets/:id/source-paths', () => {
  it('appends a source and preserves every existing catalog row', async () => {
    const original = createSource('original');
    const added = createSource('added');
    const set = backupSets.create({
      name: 'Safe',
      sourcePaths: [original],
      targetPath: '/',
      mode: 'backup',
      excludes: ['*.tmp'],
    });
    catalog.upsertDir(set.id, 'Safe/original', 1);
    catalog.upsertFile(set.id, 'Safe/original/keep.txt', 4, 1, 'old-sha', 1);
    const beforeCount = catalog.count(set.id);

    const response = await addRequest(set.id, ['/added'], ['added/private', 'added/private/**']);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.added).toBe(1);
    expect(backupSets.get(set.id)!.sourcePaths).toEqual([original, added]);
    expect(backupSets.get(set.id)!.excludes).toEqual(['*.tmp', 'added/private', 'added/private/**']);
    expect(catalog.count(set.id)).toBe(beforeCount);
    expect(catalog.getFile(set.id, 'Safe/original/keep.txt')).toEqual({
      size: 4,
      mtimeMs: 1,
      sha1: 'old-sha',
    });
  });

  it('does not mutate another backup set or its catalog', async () => {
    const aSource = createSource('a');
    const aAdded = createSource('a-added');
    const bSource = createSource('b');
    const a = backupSets.create({ name: 'A', sourcePaths: [aSource], targetPath: '/' });
    const b = backupSets.create({ name: 'B', sourcePaths: [bSource], targetPath: '/' });
    catalog.upsertFile(a.id, 'A/a/file.txt', 1, 1, null, 1);
    catalog.upsertFile(b.id, 'B/b/file.txt', 2, 2, 'b-sha', 2);

    const response = await addRequest(a.id, ['/a-added']);

    expect(response.status).toBe(200);
    expect(backupSets.get(a.id)!.sourcePaths).toEqual([aSource, aAdded]);
    expect(backupSets.get(b.id)!.sourcePaths).toEqual([bSource]);
    expect(catalog.getFile(b.id, 'B/b/file.txt')).toEqual({ size: 2, mtimeMs: 2, sha1: 'b-sha' });
  });

  it('rejects changes while the set is running and preserves state', async () => {
    const original = createSource('run-original');
    createSource('run-added');
    const set = backupSets.create({ name: 'Running', sourcePaths: [original], targetPath: '/' });
    catalog.upsertFile(set.id, 'Running/run-original/file.txt', 1, 1, null, 1);
    backupSets.updateStatus(set.id, 'running', 'Uploading', true);

    const response = await addRequest(set.id, ['/run-added']);

    expect(response.status).toBe(409);
    expect(backupSets.get(set.id)!.sourcePaths).toEqual([original]);
    expect(catalog.getFile(set.id, 'Running/run-original/file.txt')).toBeDefined();
  });

  it('rejects changes while the set is queued even before lastStatus becomes running', async () => {
    const original = createSource('queued-original');
    createSource('queued-added');
    const set = backupSets.create({ name: 'Queued', sourcePaths: [original], targetPath: '/' });
    expect(claimBackupSet(set.id)).toBe(true);
    try {
      const response = await addRequest(set.id, ['/queued-added']);
      expect(response.status).toBe(409);
      expect(backupSets.get(set.id)!.sourcePaths).toEqual([original]);
    } finally {
      releaseBackupSet(set.id);
    }
  });

  it('rejects duplicate, nested, overlapping, and missing sources', async () => {
    const original = createSource('tree');
    createSource('tree/child');
    createSource('parent');
    createSource('parent/child');
    const set = backupSets.create({ name: 'Checks', sourcePaths: [original], targetPath: '/' });

    expect((await addRequest(set.id, ['/tree'])).status).toBe(409);
    expect((await addRequest(set.id, ['/tree/child'])).status).toBe(409);
    expect((await addRequest(set.id, ['/parent', '/parent/child'])).status).toBe(409);
    expect((await addRequest(set.id, ['/missing'])).status).toBe(400);
    expect(backupSets.get(set.id)!.sourcePaths).toEqual([original]);
  });

  it('rejects a symbolic-link alias of an existing source', async () => {
    const original = createSource('real-source');
    const alias = path.join(LOCAL_ROOT, 'source-alias');
    fs.symlinkSync(original, alias, 'dir');
    const set = backupSets.create({ name: 'NoAlias', sourcePaths: [original], targetPath: '/' });

    const response = await addRequest(set.id, ['/source-alias']);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/symbolic link/);
    expect(backupSets.get(set.id)!.sourcePaths).toEqual([original]);
  });

  it('rejects an added exclusion that could change an existing source', async () => {
    const original = createSource('exclude-old');
    createSource('exclude-new');
    const set = backupSets.create({
      name: 'ExcludeScope',
      sourcePaths: [original],
      targetPath: '/',
      excludes: ['*.tmp'],
    });

    const response = await addRequest(set.id, ['/exclude-new'], ['exclude-old/private/**']);

    expect(response.status).toBe(400);
    expect(backupSets.get(set.id)!.sourcePaths).toEqual([original]);
    expect(backupSets.get(set.id)!.excludes).toEqual(['*.tmp']);
  });

  it('keeps the generic PATCH from replacing or removing existing sources', async () => {
    const original = createSource('patch-original');
    const set = backupSets.create({ name: 'Patch', sourcePaths: [original], targetPath: '/' });
    catalog.upsertFile(set.id, 'Patch/patch-original/file.txt', 1, 1, null, 1);

    const response = await PATCH(
      new Request(`http://localhost/api/backup-sets/${set.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePaths: [] }),
      }),
      { params: Promise.resolve({ id: set.id }) },
    );

    expect(response.status).toBe(400);
    expect(isBackupSetBusy(set.id)).toBe(false);
    expect(backupSets.get(set.id)!.sourcePaths).toEqual([original]);
    expect(catalog.getFile(set.id, 'Patch/patch-original/file.txt')).toBeDefined();
  });

  it('holds the set lock across asynchronous PATCH body parsing', async () => {
    const original = createSource('patch-lock');
    const set = backupSets.create({ name: 'Before', sourcePaths: [original], targetPath: '/' });
    let resolveBody!: (body: Record<string, unknown>) => void;
    const body = new Promise<Record<string, unknown>>((resolve) => {
      resolveBody = resolve;
    });

    const pending = PATCH({ json: () => body } as unknown as Request, {
      params: Promise.resolve({ id: set.id }),
    });
    await Promise.resolve();

    expect(isBackupSetBusy(set.id)).toBe(true);
    expect(claimBackupSet(set.id)).toBe(false);
    resolveBody({ name: 'After' });

    const response = await pending;
    expect(response.status).toBe(200);
    expect(backupSets.get(set.id)!.name).toBe('After');
    expect(isBackupSetBusy(set.id)).toBe(false);
  });

  it('does not delete a running set through a stale or direct API request', async () => {
    const original = createSource('delete-running');
    const set = backupSets.create({ name: 'DeleteLock', sourcePaths: [original], targetPath: '/' });
    catalog.upsertFile(set.id, 'DeleteLock/delete-running/file.txt', 1, 1, null, 1);
    backupSets.updateStatus(set.id, 'running', 'Uploading', true);

    const response = await DELETE(new Request(`http://localhost/api/backup-sets/${set.id}`), {
      params: Promise.resolve({ id: set.id }),
    });

    expect(response.status).toBe(409);
    expect(backupSets.get(set.id)).not.toBeNull();
    expect(catalog.getFile(set.id, 'DeleteLock/delete-running/file.txt')).toBeDefined();
  });
});
