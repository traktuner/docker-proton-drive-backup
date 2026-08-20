/**
 * Backup-set operation lock.
 *
 * A run claims its set before it waits for the process-wide run queue. An async
 * edit holds the same claim until every Drive and database mutation completes.
 * This closes the gap where the database still shows a terminal status although
 * a run is queued or an edit is still in flight.
 *
 * Stored on globalThis because Next.js can instantiate route modules more than
 * once inside the same server process.
 */
const g = globalThis as unknown as { __pdBusyBackupSets?: Set<string> };
const busyBackupSets = g.__pdBusyBackupSets ?? (g.__pdBusyBackupSets = new Set<string>());

export function claimBackupSet(id: string): boolean {
  if (busyBackupSets.has(id)) return false;
  busyBackupSets.add(id);
  return true;
}

export function releaseBackupSet(id: string): void {
  busyBackupSets.delete(id);
}

export function isBackupSetBusy(id: string): boolean {
  return busyBackupSets.has(id);
}
