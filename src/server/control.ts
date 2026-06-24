/**
 * Cancellation signals for running backups. A cancel request flags the set id;
 * the runner/engine check it between upload groups, and the active CLI upload
 * process is killed so the current transfer stops promptly.
 *
 * Stored on globalThis: the cancel API route and the running job can execute in
 * different module instances under Next.js, so a plain module-level Set would not
 * be shared — the job would never see the cancel. (Same pattern as progress.ts.)
 */
export type StopReason = 'cancel' | 'pause';

const g = globalThis as unknown as { __pdCancelled?: Map<string, StopReason> };
const cancelled = g.__pdCancelled ?? (g.__pdCancelled = new Map<string, StopReason>());

export const control = {
  /** Request the run to stop. `reason` distinguishes a hard cancel from a pause
   *  (the run resumes later via the delta engine); both stop the active transfer. */
  requestCancel(id: string, reason: StopReason = 'cancel') {
    cancelled.set(id, reason);
  },
  isCancelled(id: string) {
    return cancelled.has(id);
  },
  /** Why the run was stopped ('cancel' | 'pause'), or undefined if not stopped. */
  reason(id: string): StopReason | undefined {
    return cancelled.get(id);
  },
  clear(id: string) {
    cancelled.delete(id);
  },
};
