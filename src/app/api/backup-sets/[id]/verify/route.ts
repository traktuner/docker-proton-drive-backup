import { backupSets } from '@/server/db';
import { verifyCatalog } from '@/server/engine';
import { uploadsBusy } from '@/server/cli';

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
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (uploadsBusy()) {
    return Response.json({ error: 'A backup is running - verify after it finishes.' }, { status: 409 });
  }
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (set.mode === 'add') {
    return Response.json({ error: 'Verify applies to backup/mirror sets only.' }, { status: 400 });
  }
  if (g.__pdVerifying) {
    return Response.json({ error: 'A verify is already running - wait for it to finish.' }, { status: 409 });
  }
  // Read-only on Drive; only removes catalog rows (idempotent). Single-flighted so
  // concurrent requests can't pile up multiple full-Drive scans.
  g.__pdVerifying = true;
  try {
    const res = await verifyCatalog(id, set.targetPath, set.targetSubfolder);
    return Response.json(res, { status: res.ok ? 200 : 502 });
  } finally {
    g.__pdVerifying = false;
  }
}
