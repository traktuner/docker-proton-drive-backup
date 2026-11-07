import { backupSets } from '@/server/db';
import { verifySet, specFor } from '@/server/engine';
import { drive, uploadsBusy, writeGate } from '@/server/drive';
import { claimBackupSet, releaseBackupSet } from '@/server/backup-lock';

export const dynamic = 'force-dynamic';

// One verify at a time across the process (a full Drive scan is expensive). On
// globalThis so the flag is shared across route module instances. This is exactly
// the normal UI behaviour and bounds an unauthenticated caller to a single scan.
const g = globalThis as unknown as { __pdVerifying?: boolean };

/**
 * Reconcile a set's catalog against Drive truth: drop entries that were deleted or
 * changed externally on Drive so the next backup re-uploads them. Read-only on
 * Drive (never trashes). Synchronous — for huge sets this is a full Drive scan, so
 * it may take a while; the client shows a spinner.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (uploadsBusy()) {
    return Response.json({ error: 'A backup is running - verify after it finishes.' }, { status: 409 });
  }
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (g.__pdVerifying) {
    return Response.json({ error: 'A verify is already running - wait for it to finish.' }, { status: 409 });
  }
  // Read-only on Drive; only removes catalog rows (idempotent). Single-flighted so
  // concurrent requests can't pile up multiple full-Drive scans.
  // The set's own lock too: no run of this set (scheduled or manual) and no edit
  // (target change, rename) may start while verify rewrites its catalog.
  if (!claimBackupSet(id)) {
    return Response.json({ error: 'This set is busy (running or being edited) - try again when it is idle.' }, { status: 409 });
  }
  g.__pdVerifying = true;
  try {
    // Verify only edits OUR catalog, but it must still be the bound account's Drive.
    const blocked = await writeGate();
    if (blocked) return Response.json({ error: blocked }, { status: 409 });
    // `?content=1` additionally compares every local file's SHA-1 with Drive's.
    const content = new URL(req.url).searchParams.get('content') === '1';
    const res = await verifySet(await drive(), specFor(set), { content });
    return Response.json(res, { status: res.ok ? 200 : 502 });
  } finally {
    g.__pdVerifying = false;
    releaseBackupSet(id);
  }
}
