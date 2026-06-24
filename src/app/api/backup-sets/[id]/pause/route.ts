import { backupSets } from '@/server/db';
import { cancelBackupSet } from '@/server/runner';

export const dynamic = 'force-dynamic';

// Pause a running set and mark it 'paused'. Resuming is just running it again - the
// delta engine continues from the catalog (already-uploaded files are skipped).
//   ?force=1 → stop NOW (a file mid-upload is discarded, re-uploaded on resume).
//   default  → graceful: let the current upload finish, then stop (nothing wasted).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (set.lastStatus !== 'running') {
    return Response.json({ error: 'not running' }, { status: 409 });
  }
  const force = new URL(req.url).searchParams.get('force') === '1';
  cancelBackupSet(id, 'pause', force);
  return Response.json({ ok: true });
}
