import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountMismatch, bindAccount } from './account-binding';

test('exactly one account can claim a fresh backup directory, including concurrent first logins', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sdk-bind-'));
  try {
    const ids = ['user-one', 'user-two'];
    const results = await Promise.allSettled(ids.map((id) => bindAccount(dir, id)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    await bindAccount(dir, ids[winner]);
    await expect(bindAccount(dir, ids[1 - winner])).rejects.toBeInstanceOf(AccountMismatch);
    await expect(bindAccount(dir, undefined)).rejects.toThrow();
    const file = path.join(dir, 'backup-account.sha256');
    expect((await readFile(file, 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
