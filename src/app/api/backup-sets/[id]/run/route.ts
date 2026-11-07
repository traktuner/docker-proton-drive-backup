import { backupSets } from '@/server/db';
import { runBackupSet } from '@/server/runner';
import { isBackupSetBusy } from '@/server/backup-lock';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (set.lastStatus === 'running' || isBackupSetBusy(id)) {
    return Response.json({ error: 'already queued or running' }, { status: 409 });
  }

  // Fire-and-forget; UI polls the backup set status. Swallow async rejections so a
  // failure can never surface as an unhandled promise rejection (status is written
  // inside the runner; the UI sees it via polling).
  // `?allowEmptySource=1`: the user confirmed in the UI that an empty mirror source
  // was emptied on purpose (one run only).
  const allowEmptySource = new URL(req.url).searchParams.get('allowEmptySource') === '1';
  void runBackupSet(id, { allowEmptySource }).catch((e) => console.error('[run] backup set %s failed:', id, e));
  return Response.json({ ok: true, status: 'running' });
}
