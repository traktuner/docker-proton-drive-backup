import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as drive from './drive';
import { catalog } from './catalog';
import { runCatalogDelta, uploadSourceTrees, verifyCatalog } from './engine';
import { LOCAL_ROOT } from './local';
import { setMirrorSafetyConfig } from './mirror-safety';

vi.mock('./drive', async (original) => ({
  ...await original<typeof import('./drive')>(),
  createFolder: vi.fn(), upload: vi.fn(), trashDrive: vi.fn(), listDrive: vi.fn(),
}));

beforeEach(() => {
  vi.stubEnv('DRIVE_BACKEND', 'sdk');
  vi.mocked(drive.createFolder).mockResolvedValue({ ok: true, data: {} });
  vi.mocked(drive.upload).mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  setMirrorSafetyConfig({ enabled: false, deleteSafetyPct: 0.3 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it('preserves empty directories and their ancestors across successive mirror runs', async () => {
  const src = path.join(LOCAL_ROOT, 'first');
  await mkdir(path.join(src, 'empty'), { recursive: true });
  const run = () => runCatalogDelta('first', [src], '/', 'Set', 'mirror');
  expect((await run()).ok).toBe(true);
  expect(catalog.hasDir('first', 'Set/first/empty')).toBe(true);
  expect(drive.createFolder).toHaveBeenCalledWith('/my-files/Set/first', 'empty', true);
  expect((await run()).ok).toBe(true);
  expect(drive.trashDrive).not.toHaveBeenCalled();
  expect(drive.upload).not.toHaveBeenCalled();
});

it('does not record unconfirmed folders or trash stale items after a mkdir failure', async () => {
  const src = path.join(LOCAL_ROOT, 'second');
  await mkdir(src);
  await writeFile(path.join(src, 'new'), 'content');
  catalog.upsertFile('second', 'Set/second/old', 1, 1, null, 1);
  vi.mocked(drive.createFolder).mockResolvedValue({ ok: false, error: 'temporarily unavailable' });
  const res = await runCatalogDelta('second', [src], '/', 'Set', 'mirror');
  expect(res.ok).toBe(false);
  expect(res.failedCount).toBe(1);
  expect(catalog.hasDir('second', 'Set')).toBe(false);
  expect(drive.upload).not.toHaveBeenCalled();
  expect(drive.trashDrive).not.toHaveBeenCalled();
});

it('fails add mode for missing sources and for unconfirmed destination folders', async () => {
  const src = path.join(LOCAL_ROOT, 'third');
  const add = () => uploadSourceTrees([{ abs: src, relBase: 'Set/third' }], '/my-files', 'skip', 'merge');
  await expect(add()).rejects.toThrow();
  await mkdir(src);
  vi.mocked(drive.createFolder).mockResolvedValue({ ok: false, error: 'Name belongs to a file' });
  await expect(add()).rejects.toThrow('Name belongs to a file');
});

it('requires readable configured sources and keeps the mirror catalog when a source goes offline', async () => {
  const src = path.join(LOCAL_ROOT, 'fourth');
  await mkdir(src);
  await writeFile(path.join(src, 'a'), 'file');
  const run = () => runCatalogDelta('fourth', [src], '/', 'Set', 'mirror');
  expect((await run()).ok).toBe(true);
  await rename(src, src + '.offline');
  const result = await run();
  expect(result.ok).toBe(false);
  expect(result.failedCount).toBeGreaterThan(0);
  expect(catalog.getFile('fourth', 'Set/fourth/a')).toBeDefined();
  expect(drive.trashDrive).not.toHaveBeenCalled();
});

it('verify only invalidates a missing directory and its contents after confirmed absence', async () => {
  catalog.upsertDir('verify-sdk', 'Set', 1);
  catalog.upsertFile('verify-sdk', 'Set/a', 1, 1, null, 1);
  const verify = () => verifyCatalog('verify-sdk', '/', 'Set');
  vi.mocked(drive.listDrive).mockResolvedValue({ ok: false, error: 'key not found' });
  expect((await verify()).ok).toBe(false);
  expect(catalog.count('verify-sdk')).toBe(2);
  const missing = { ok: false as const, error: 'Folder missing', code: 'NOT_FOUND' };
  vi.mocked(drive.listDrive).mockResolvedValue(missing);
  expect(await verify()).toMatchObject({ ok: true, repaired: 2 });
  expect(catalog.count('verify-sdk')).toBe(0);
});
