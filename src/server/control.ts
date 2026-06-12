/**
 * Cancellation signals for running backups. A cancel request flags the set id;
 * the runner/engine check it between upload groups, and the active CLI upload
 * process is killed so the current transfer stops promptly.
 *
 * Stored on globalThis: the cancel API route and the running job can execute in
 * different module instances under Next.js, so a plain module-level Set would not
 * be shared — the job would never see the cancel. (Same pattern as progress.ts.)
 */
const g = globalThis as unknown as { __pdCancelled?: Set<string> };
const cancelled = g.__pdCancelled ?? (g.__pdCancelled = new Set<string>());

export const control = {
  requestCancel(id: string) {
    cancelled.add(id);
  },
  isCancelled(id: string) {
    return cancelled.has(id);
  },
  clear(id: string) {
    cancelled.delete(id);
  },
};
