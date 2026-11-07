import { backupSets } from './db';
import { drive, normalizeProtonPath, setBackupRunning, writeGate, invalidateFolder } from './drive';
import { runSet, type RunSpec } from './engine';
import { progress } from './progress';
import { control } from './control';
import { runs } from './runs';
import { claimBackupSet, releaseBackupSet } from './backup-lock';

/**
 * Runs a backup set. Fire-and-forget — the UI polls status. One set runs at a
 * time (the engine parallelises inside a run); queued sets wait their turn.
 */
let runChain: Promise<unknown> = Promise.resolve();

const g = globalThis as unknown as { __pdAborts?: Map<string, AbortController> };
const aborts = g.__pdAborts ?? (g.__pdAborts = new Map());

export interface RunRequest {
  /** One-shot confirmation of the sources' current state (emptied / remounted on purpose). */
  confirmSources?: boolean;
}

export async function runBackupSet(id: string, req: RunRequest = {}): Promise<void> {
  // Claim synchronously, before the first await: a queued set is not editable.
  if (!claimBackupSet(id)) return;
  const prev = runChain;
  let release!: () => void;
  runChain = new Promise<void>((r) => (release = r));
  await prev.catch(() => {});
  try {
    await doRun(id, req);
  } finally {
    release();
    releaseBackupSet(id);
  }
}

async function doRun(id: string, req: RunRequest): Promise<void> {
  const set = backupSets.get(id);
  if (!set) return;

  // The single gate for every writing job: a live session AND the bound account.
  const blocked = await writeGate();
  if (blocked) {
    backupSets.updateStatus(id, 'error', blocked, true);
    return;
  }
  if (set.sourcePaths.length === 0) {
    backupSets.updateStatus(id, 'error', 'No source paths configured', true);
    return;
  }

  const startedAt = Date.now();
  control.clear(id);
  const abort = new AbortController();
  aborts.set(id, abort);
  setBackupRunning(true);
  backupSets.updateStatus(id, 'running', 'Starting…', true);
  const log = (msg: string) => backupSets.updateStatus(id, 'running', msg, false);
  const stopStatus = (): 'cancelled' | 'paused' => (control.reason(id) === 'pause' ? 'paused' : 'cancelled');
  let skipped: { rel: string; reason: string }[] = [];

  try {
    const spec: RunSpec = {
      setId: id,
      sourcePaths: set.sourcePaths,
      targetPath: normalizeProtonPath(set.targetPath),
      subfolder: set.targetSubfolder,
      mode: set.mode,
      excludes: set.excludes,
      skipThumbnails: set.skipThumbnails,
      includeHidden: set.includeHidden,
      confirmSources: req.confirmSources,
    };
    const result = await runSet(await drive(), spec, {
      log,
      onProgress: (p) => progress.set(id, p),
      shouldCancel: () => control.isCancelled(id),
      signal: abort.signal,
    });
    skipped = result.failedFiles;
    const status = result.cancelled ? stopStatus() : result.ok ? 'success' : 'error';
    const message = result.cancelled && status === 'paused' ? result.message.replace(/^Cancelled/, 'Paused') : result.message;
    backupSets.updateStatus(id, status, message, true);
  } catch (e) {
    const stopped = control.isCancelled(id);
    backupSets.updateStatus(id, stopped ? stopStatus() : 'error', stopped ? (stopStatus() === 'paused' ? 'Paused' : 'Cancelled') : errorText(e), true);
  } finally {
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
        skipped,
      });
    }
    progress.clear(id);
    control.clear(id);
    aborts.delete(id);
    setBackupRunning(false);
    invalidateFolder(); // the browse cache may predate this run's folders
  }
}

function errorText(e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === 'UNAUTHENTICATED') return 'Proton session expired — reconnect to Proton Drive to resume backups. Your backup set is unchanged.';
  if (code === 'NETWORK') return 'Network error talking to Proton — the run stopped; nothing was deleted. It resumes on the next run.';
  if (code === 'RATE_LIMITED') return 'Proton is rate-limiting this account — the run stopped; it resumes on the next run.';
  return e instanceof Error ? e.message.split('\n')[0].slice(0, 300) : String(e);
}

/**
 * Stop a running set immediately: the abort signal interrupts in-flight transfers
 * (no process to kill anymore). 'pause' marks it resumable; resume continues
 * where it stopped because every confirmed file is already in the catalog.
 */
export function cancelBackupSet(id: string, reason: 'cancel' | 'pause' = 'cancel') {
  control.requestCancel(id, reason);
  aborts.get(id)?.abort();
}
