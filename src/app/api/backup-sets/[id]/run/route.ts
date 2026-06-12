import { backupSets } from '@/server/db';
import { runBackupSet } from '@/server/runner';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (set.lastStatus === 'running') {
    return Response.json({ error: 'already running' }, { status: 409 });
  }

  // Fire-and-forget; UI polls the backup set status.
  void runBackupSet(id);
  return Response.json({ ok: true, status: 'running' });
}
