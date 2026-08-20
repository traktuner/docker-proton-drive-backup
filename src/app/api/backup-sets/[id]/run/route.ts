import { backupSets } from '@/server/db';
import { runBackupSet } from '@/server/runner';
import { isBackupSetBusy } from '@/server/backup-lock';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (set.lastStatus === 'running' || isBackupSetBusy(id)) {
    return Response.json({ error: 'already queued or running' }, { status: 409 });
  }

  // Fire-and-forget; UI polls the backup set status. Swallow async rejections so a
  // failure can never surface as an unhandled promise rejection (status is written
  // inside the runner; the UI sees it via polling).
  void runBackupSet(id).catch((e) => console.error('[run] backup set %s failed:', id, e));
  return Response.json({ ok: true, status: 'running' });
}
