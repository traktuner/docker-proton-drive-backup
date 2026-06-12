import { backupSets } from '@/server/db';
import { verifyCatalog } from '@/server/engine';
import { uploadsBusy } from '@/server/cli';

export const dynamic = 'force-dynamic';

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
  // Read-only on Drive; only removes catalog rows (idempotent). The uploadsBusy()
  // guard above keeps it off while a backup runs; a stray concurrent verify is
  // harmless (same DELETEs), so no extra busy flag is needed here.
  const res = await verifyCatalog(id, set.targetPath, set.targetSubfolder);
  return Response.json(res, { status: res.ok ? 200 : 502 });
}
