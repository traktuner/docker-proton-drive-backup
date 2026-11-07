import { trashDrive, normalizeProtonPath, cleanDriveError } from '@/server/drive';
import { backupSets } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { path, uid } = body as { path?: string; uid?: string };
  if (!path || path === '/') {
    return Response.json({ error: 'a valid path is required' }, { status: 400 });
  }

  // Failsafe: refuse to trash a folder that is (or contains) a backup target -
  // deleting it out from under a backup set is exactly what we can prevent.
  const norm = normalizeProtonPath(path);
  const blockers = backupSets
    .all()
    .filter((s) => {
      const t = normalizeProtonPath(s.targetPath);
      return t === norm || t.startsWith(`${norm}/`);
    })
    .map((s) => s.name);
  if (blockers.length > 0) {
    return Response.json(
      {
        error: `This folder is the backup target for: ${blockers.join(', ')}. Change or delete the backup set first.`,
      },
      { status: 409 },
    );
  }

  // `uid` (from the listing the user clicked in) makes the trash refuse if a
  // different item has taken that name in the meantime.
  const res = await trashDrive(path, uid);
  if (!res.ok) {
    return Response.json({ error: cleanDriveError(null, res.code) }, { status: res.code === 'NAME_CONFLICT' ? 409 : 502 });
  }
  return Response.json({ ok: true });
}
