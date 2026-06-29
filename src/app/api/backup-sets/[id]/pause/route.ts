import { backupSets } from '@/server/db';
import { cancelBackupSet } from '@/server/runner';

export const dynamic = 'force-dynamic';

// Pause a running set: stop the active transfer now and mark it 'paused'. Resuming
// is just running it again - the delta engine / `-f skip` continue from the catalog
// (already-uploaded files are skipped).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (set.lastStatus !== 'running') {
    return Response.json({ error: 'not running' }, { status: 409 });
  }
  cancelBackupSet(id, 'pause');
  return Response.json({ ok: true });
}
