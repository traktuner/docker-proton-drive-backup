import { backupSets } from './db';
import { killActiveUpload, drivePathExists, normalizeProtonPath, setBackupRunning } from './cli';
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

  const startedAt = Date.now();
  control.clear(id);
  // Mark the whole run busy so a concurrent cache resync can't wipe folder nodes
  // we just created (cleared in the finally below).
  setBackupRunning(true);
  backupSets.updateStatus(id, 'running', 'Starting…', true);
  const log = (msg: string) => backupSets.updateStatus(id, 'running', msg, false);
  let ok = false;

  // If a cancel landed, stop here and mark it cancelled. Checked after each
  // awaited phase (verify, etc.) so cancelling between steps takes effect.
  const bailIfCancelled = (): boolean => {
    if (!control.isCancelled(id)) return false;
    backupSets.updateStatus(id, 'cancelled', 'Cancelled', true);
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
      backupSets.updateStatus(
        id,
        cancelled ? 'cancelled' : ok ? 'success' : 'error',
        cancelled
          ? 'Cancelled'
          : ok
            ? 'Added new files'
            : (res.stderr.trim() || res.stdout.trim() || `CLI exited with code ${res.code}`).slice(0, 1000),
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
      backupSets.updateStatus(
        id,
        result.cancelled ? 'cancelled' : ok ? 'success' : 'error',
        result.message,
        true,
      );
    }
  } catch (e) {
    backupSets.updateStatus(
      id,
      control.isCancelled(id) ? 'cancelled' : 'error',
      control.isCancelled(id) ? 'Cancelled' : e instanceof Error ? e.message : String(e),
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

/** Request cancellation of a running set and stop the active upload promptly. */
export function cancelBackupSet(id: string) {
  control.requestCancel(id);
  killActiveUpload();
}
