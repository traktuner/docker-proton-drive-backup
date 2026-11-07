import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import type { ProtonRuntime } from '@/server/proton/types';

/**
 * Contract test of the REAL SDK bundle (dist-proton/runtime.mjs, built from the
 * pinned SDK): it loads in Node, initialises the crypto endpoint (this fails if
 * the openpgp/lightweight alias — PATCHES.md #1 — is missing), reports the
 * pinned versions, and handles the CLI session file. No network access.
 */
const ROOT = path.resolve(__dirname, '..');
const UPSTREAM = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/server/proton/vendor/UPSTREAM.json'), 'utf8'));
let createRuntime: (o: unknown) => Promise<ProtonRuntime>;
let mapError: (e: unknown) => { code: string };
let LruCache: new <T>(max: number) => {
  setEntity(k: string, v: T, tags?: string[]): Promise<void>;
  getEntity(k: string): Promise<T>;
  iterateEntitiesByTag(t: string): AsyncGenerator<{ key: string; ok: boolean }>;
  removeEntities(k: string[]): Promise<void>;
  size: number;
};

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-proton.mjs')], { cwd: ROOT, stdio: 'pipe' });
  ({ createRuntime, LruCache, mapError } = await import(pathToFileURL(path.join(ROOT, 'dist-proton/runtime.mjs')).href));
}, 120_000);

describe('SDK runtime bundle', () => {
  it('loads, reports the pinned SDK and identifies honestly as a third-party app', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-rt-'));
    const rt = await createRuntime({ sessionDir: dir, appVersion: '1.2.3', appBuild: 'abc1234', clientUid: 'proton_drive_backup-test' });
    expect(rt.versions.sdk).toBe(UPSTREAM.sdkVersion);
    expect(rt.versions.sdkCommit).toBe(UPSTREAM.commit);
    expect(rt.versions.appVersionHeader).toBe('external-drive-proton_drive_backup@1.2.3-stable+abc1234');
    expect(rt.hasSession()).toBe(false);
    expect(await rt.account()).toBeNull();
    await expect(rt.drive.root()).rejects.toMatchObject({ name: 'DriveError', code: 'UNAUTHENTICATED' });
    await rt.dispose();
  });

  it('picks up a CLI session file and logs out by removing it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-rt-'));
    fs.writeFileSync(
      path.join(dir, 'auth-session.json'),
      JSON.stringify({ cachePassword: 'c', userKeyPassword: 'k', session: { uid: 'u', accessToken: 'a', refreshToken: 'r' } }),
      { mode: 0o600 },
    );
    const rt = await createRuntime({ sessionDir: dir, appVersion: '1.2.3', clientUid: 'x', baseUrl: '127.0.0.1:9' });
    expect(rt.hasSession()).toBe(true);
    await rt.logout(); // server-side revoke fails offline; the local session is still removed
    expect(rt.hasSession()).toBe(false);
    expect(fs.existsSync(path.join(dir, 'auth-session.json'))).toBe(false);
    await rt.dispose();
  });
});

describe('LruCache (replaces the SDK MemoryCache: bounded, O(1))', () => {
  it('evicts the least recently used entry and keeps the tag index consistent', async () => {
    const c = new LruCache<string>(3); // evicts down to 90% (2 entries) when exceeded
    await c.setEntity('a', '1', ['parent-x']);
    await c.setEntity('b', '2', ['parent-x']);
    await c.setEntity('c', '3');
    await c.getEntity('a'); // a is now most recent
    await c.setEntity('d', '4', ['parent-x']); // evicts the oldest (b, then c)
    expect(c.size).toBeLessThanOrEqual(3);
    await expect(c.getEntity('b')).rejects.toThrow();
    const tagged: string[] = [];
    for await (const r of c.iterateEntitiesByTag('parent-x')) if (r.ok) tagged.push(r.key);
    expect(tagged.sort()).toEqual(['a', 'd']);
    await expect(c.getEntity('c')).rejects.toThrow();
    await c.removeEntities(['a']);
    tagged.length = 0;
    for await (const r of c.iterateEntitiesByTag('parent-x')) if (r.ok) tagged.push(r.key);
    expect(tagged).toEqual(['d']);
  });

  it('stays fast and bounded with 200k entries', async () => {
    const c = new LruCache<string>(20_000);
    const t0 = performance.now();
    for (let i = 0; i < 200_000; i++) await c.setEntity(`node-${i}`, 'v', [`parent-${i % 100}`]);
    expect(c.size).toBeLessThanOrEqual(20_000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('Proton API error codes → permanent DriveError codes', () => {
  it('classifies the folder item limit, nesting, size and quota codes (never "transient")', () => {
    const v = (code: number, message = 'x') => ({ name: 'ValidationError', code, message });
    expect(mapError(v(200300, 'Ordnerlimit erreicht.')).code).toBe('FOLDER_FULL');
    expect(mapError(v(200301)).code).toBe('TOO_DEEP');
    expect(mapError(v(200003)).code).toBe('FILE_TOO_LARGE');
    expect(mapError(v(200001)).code).toBe('QUOTA');
    expect(mapError({ name: 'Error', message: 'wrapped', cause: { code: 200300 } }).code).toBe('FOLDER_FULL');
    expect(mapError({ name: 'NotFoundAPIError', code: 2501, message: 'gone' }).code).toBe('NOT_FOUND');
  });
});
