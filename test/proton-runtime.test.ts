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

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-proton.mjs')], { cwd: ROOT, stdio: 'pipe' });
  ({ createRuntime } = await import(pathToFileURL(path.join(ROOT, 'dist-proton/runtime.mjs')).href));
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
