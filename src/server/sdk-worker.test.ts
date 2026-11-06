import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SdkWorker } from './sdk-worker';

const tempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fakeWorker(body: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'drive-worker-'));
  tempDirs.push(dir);
  const executable = path.join(dir, 'worker.cjs');
  await writeFile(executable, '#!/usr/bin/env node\n' + body);
  await chmod(executable, 0o700);
  vi.stubEnv('DRIVE_SDK_WORKER', executable);
  return new SdkWorker();
}

describe('persistent SDK worker protocol', () => {
  it('routes interleaved results and per-transfer progress to the correct caller', async () => {
    const worker = await fakeWorker(`
      const lines = require('node:readline').createInterface({ input: process.stdin });
      const send = data => process.stdout.write(JSON.stringify(data) + '\\n');
      let upload;
      lines.on('line', line => {
        const { id, method } = JSON.parse(line);
        if (method === 'upload') { upload = id; return; }
        if (method === 'status') {
          send({ id: upload, progress: 12 });
          send({ id, result: { authenticated: true, loginState: 'authenticated' } });
          send({ id: upload, result: { uploaded: 1 } });
        }
        if (method === 'logout') { send({ id, result: true }); process.exit(0); }
      });
    `);
    const progress = vi.fn();
    const [transfer, status] = await Promise.all([
      worker.call('upload', { sources: ['/sources/a'], dest: '/my-files', fileStrategy: 'skip',
        folderStrategy: 'merge', skipThumbnails: true, includeHidden: false }, progress),
      worker.call('status', {}),
    ]);
    expect(transfer).toEqual({ uploaded: 1 });
    expect(status.authenticated).toBe(true);
    expect(progress).toHaveBeenCalledExactlyOnceWith(12);
    await worker.call('logout', {});
  });

  it('fails outstanding mutations on a crash, without replaying them', async () => {
    const worker = await fakeWorker(`
      const lines = require('node:readline').createInterface({ input: process.stdin });
      lines.on('line', line => {
        const {id, method} = JSON.parse(line);
        if (method === 'list') return;
        if (method === 'trash') return process.exit(1);
        process.stdout.write(JSON.stringify({ id, result: 'ready' }) + '\\n', () => process.exit(0));
      });
    `);
    const outcomes = await Promise.allSettled([
      worker.call('list', { path: '/my-files' }), worker.call('trash', { path: '/my-files/test' }),
    ]);
    expect(outcomes.map(r => r.status)).toEqual(['rejected', 'rejected']);
    await expect(worker.call('version', {})).resolves.toBe('ready');
  });
});
