import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export class AccountMismatch extends Error {
  constructor() {
    super('This backup catalog belongs to a different Proton account. Sign in with the original account.');
  }
}

// Bind the first account to this persistent data directory. A link publishes
// the completed record atomically and cannot replace an existing binding.
export async function bindAccount(dataDir: string, userId: unknown) {
  if (typeof userId !== 'string' || !userId.length)
    throw new Error('Proton did not confirm the account identity');
  const expected = createHash('sha256').update(userId).digest('hex') + '\n';
  const filename = path.join(dataDir, 'backup-account.sha256');
  let stored: string;
  try {
    stored = await readFile(filename, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const temporary = filename + '.' + randomUUID();
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(expected);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await unlink(temporary);
    }
    const directory = await open(dataDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    stored = await readFile(filename, 'utf8');
  }
  if (stored !== expected) throw new AccountMismatch();
}
