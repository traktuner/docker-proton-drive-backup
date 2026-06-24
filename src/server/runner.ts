import { backupSets } from './db';
import {
  killActiveUpload,
  drivePathExists,
  normalizeProtonPath,
  setBackupRunning,
  isAuthenticated,
  looksUnauthenticated,
} from './cli';
import { runCatalogDelta, uploadSourceTrees, relBaseFor } from './engine';
import { progress } from './progress';
import { control } from './control';
import { runs } from './runs';

/**
 * Runs a backup set. Fire-and-forget - the UI polls status.
 *
 *  - add:    lightweight CLI pass (`-f skip -d merge`) - uploads only files that
 *            don't exist yet, never re-reads/hashes. Cheapest.
 *  - backup: catalog delta engine - streams the local tree, uploads new + changed
 *            files (size/mtime/sha1 vs the persisted catalog), never deletes.
 *            Scales to millions of files (no Drive re-scan, bounded memory).
 *  - mirror: catalog delta engine - like backup, plus trashes catalog entries
 *            that no longer exist locally (scoped to the source roots).
 */
// Only one backup set runs at a time (its engine manages internal concurrency).
let runChain: Promise<unknown> = Promise.resolve();

export async function runBackupSet(id: string): Promise<void> {
  const prev = runChain;
  let release!: () => void;
  runChain = new Promise<void>((r) => (release = r));
  await prev.catch(() => {});
  try {
    await doRunBackupSet(id);
  } finally {
    release();
  }
}

async function doRunBackupSet(id: string): Promise<void> {
  const set = backupSets.get(id);
  if (!set) return;

  // Failsafe: don't start an upload phase against a session we already know is dead
  // (a prior op flipped the flag, or the cached probe says so) — fail fast with a
  // clear "reconnect" message and no 'running' flash. Deliberately NOT forced: a
  // forced probe could spuriously fail on a transient network blip and skip a
  // healthy run with no retry. If the in-memory flag is still optimistically
  // 'authenticated' but the session has silently expired, the engine's precise
  // (auth-text-gated) sessionDead detection aborts the run cleanly instead. Either
  // way the set itself is left untouched.
  if (!(await isAuthenticated())) {
    backupSets.updateStatus(
      id,
      'error',
      'Proton session expired — reconnect to Proton Drive to resume backups. Your backup set is unchanged.',
      true,
    );
    return;
  }

  const startedAt = Date.now();
  control.clear(id);
  // Mark the whole run busy so a concurrent cache resync can't wipe folder nodes
  // we just created (cleared in the finally below).
  setBackupRunning(true);
  backupSets.updateStatus(id, 'running', 'Starting…', true);
  const log = (msg: string) => backupSets.updateStatus(id, 'running', msg, false);
  let ok = false;

  // A stop can be a hard cancel or a pause (resumes later via the delta engine).
  // Both stop the transfer; only the resulting status/label differ.
  const stopStatus = (): 'cancelled' | 'paused' => (control.reason(id) === 'pause' ? 'paused' : 'cancelled');
  const stopMsg = (): string => (control.reason(id) === 'pause' ? 'Paused' : 'Cancelled');

  // If a stop landed, record it and bail. Checked after each awaited phase so
  // stopping between steps takes effect.
  const bailIfCancelled = (): boolean => {
    if (!control.isCancelled(id)) return false;
    backupSets.updateStatus(id, stopStatus(), stopMsg(), true);
    return true;
  };

  try {
    if (set.sourcePaths.length === 0) {
      backupSets.updateStatus(id, 'error', 'No source paths configured', true);
      return;
    }

    // Failsafe: verify the target still exists on Drive (it may have been deleted
    // externally). `info` is server-truth, unlike the cached `list`. Never let a
    // backup silently report "0 uploaded" against a vanished target.
    if (bailIfCancelled()) return;
    log('Verifying target…');
    const targetOk = await drivePathExists(set.targetPath);
    if (bailIfCancelled()) return;
    if (targetOk === false) {
      backupSets.updateStatus(
        id,
        'error',
        `Target "${set.targetPath === '/' ? 'Drive (root)' : 'Drive' + set.targetPath}" no longer exists on Drive - backup did NOT run. Recreate the folder or change the target.`,
        true,
      );
      return;
    }

    if (set.mode === 'add') {
      log('Uploading new files…');
      const target = normalizeProtonPath(set.targetPath);
      const sources = set.sourcePaths.map((abs) => ({ abs, relBase: relBaseFor(set.targetSubfolder, abs) }));
      const res = await uploadSourceTrees(sources, target, 'skip', 'merge');
      const cancelled = control.isCancelled(id);
      ok = res.code === 0 && !cancelled;
      const failMsg = looksUnauthenticated(res.stderr + res.stdout)
        ? 'Proton session expired — reconnect to Proton Drive to resume backups. Your backup set is unchanged.'
        : (res.stderr.trim() || res.stdout.trim() || `CLI exited with code ${res.code}`).slice(0, 1000);
      backupSets.updateStatus(
        id,
        cancelled ? stopStatus() : ok ? 'success' : 'error',
        cancelled ? stopMsg() : ok ? 'Added new files' : failMsg,
        true,
      );
    } else {
      const result = await runCatalogDelta(
        id,
        set.sourcePaths,
        set.targetPath,
        set.targetSubfolder,
        set.mode,
        set.excludes,
        log,
        (p) => progress.set(id, p),
        () => control.isCancelled(id),
      );
      ok = result.ok;
      const status = result.cancelled ? stopStatus() : ok ? 'success' : 'error';
      // The engine labels a stopped run "Cancelled - …"; relabel for a pause.
      const message =
        result.cancelled && status === 'paused'
          ? result.message.replace(/^Cancelled/, 'Paused')
          : result.message;
      backupSets.updateStatus(id, status, message, true);
    }
  } catch (e) {
    backupSets.updateStatus(
      id,
      control.isCancelled(id) ? stopStatus() : 'error',
      control.isCancelled(id) ? stopMsg() : e instanceof Error ? e.message : String(e),
      true,
    );
  } finally {
    // Record the run in history (trust signals) before clearing live progress.
    const p = progress.get(id);
    const fin = backupSets.get(id);
    if (fin && (fin.lastStatus === 'success' || fin.lastStatus === 'error' || fin.lastStatus === 'cancelled')) {
      runs.record(id, {
        startedAt,
        finishedAt: Date.now(),
        status: fin.lastStatus,
        message: fin.lastMessage,
        files: p?.doneFiles ?? 0,
        bytes: p?.doneBytes ?? 0,
      });
    }
    progress.clear(id);
    control.clear(id);
    setBackupRunning(false);
  }
}

/**
 * Stop a running set. `reason: 'pause'` marks it resumable (status 'paused'); the
 * default hard-cancels it (status 'cancelled'). `force` (default true) SIGKILLs the
 * active transfer NOW - instant, but a file mid-upload is discarded and re-uploaded
 * on resume (Proton uploads don't survive a kill). `force: false` is a GRACEFUL
 * stop: the current upload finishes (nothing wasted), then the engine stops before
 * the next batch - so no work is thrown away, at the cost of waiting out the
 * in-flight file. Either way the delta engine continues from the catalog next run.
 */
export function cancelBackupSet(id: string, reason: 'cancel' | 'pause' = 'cancel', force = true) {
  control.requestCancel(id, reason);
  if (force) killActiveUpload();
}
