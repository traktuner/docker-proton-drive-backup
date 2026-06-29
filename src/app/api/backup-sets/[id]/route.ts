import path from 'node:path';
import { backupSets, type BackupMode, type Schedule } from '@/server/db';
import { resolveLocal, LOCAL_ROOT } from '@/server/local';
import { catalog } from '@/server/catalog';
import { runs } from '@/server/runs';

export const dynamic = 'force-dynamic';

const MODES: BackupMode[] = ['add', 'backup', 'mirror'];
const SCHEDULES: Schedule[] = ['off', 'hourly', 'daily', 'weekly'];

/**
 * Resolve a source path that may already be a stored ABSOLUTE in-container path
 * (e.g. "/sources/Photos"). resolveLocal() treats its argument as LOCAL_ROOT-
 * relative, so passing it an already-absolute path doubles the prefix
 * ("/sources/sources/Photos"). The edit form round-trips the stored absolute
 * paths, so guard against that here: keep a path that's already under LOCAL_ROOT
 * as-is (normalised + traversal-checked), and only resolve genuinely relative ones.
 */
function resolveSourceMaybeAbsolute(p: string): string {
  if (p === LOCAL_ROOT || p.startsWith(LOCAL_ROOT + path.sep)) {
    const norm = path.normalize(p);
    if (norm !== LOCAL_ROOT && !norm.startsWith(LOCAL_ROOT + path.sep)) {
      throw new Error('Path escapes LOCAL_ROOT');
    }
    return norm;
  }
  return resolveLocal(p);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ backupSet: set });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cur = backupSets.get(id);
  if (!cur) return Response.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Parameters<typeof backupSets.update>[1] = {};

  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.targetPath === 'string' && body.targetPath.trim()) patch.targetPath = body.targetPath.trim();
  if (MODES.includes(body.mode as BackupMode)) patch.mode = body.mode as BackupMode;
  if (SCHEDULES.includes(body.schedule as Schedule)) patch.schedule = body.schedule as Schedule;
  if (body.scheduleHour != null) patch.scheduleHour = Math.min(23, Math.max(0, +body.scheduleHour || 0));
  if (body.scheduleMinute != null) patch.scheduleMinute = Math.min(59, Math.max(0, +body.scheduleMinute || 0));
  if (body.scheduleDow != null) patch.scheduleDow = Math.min(6, Math.max(0, +body.scheduleDow || 0));
  if (typeof body.skipThumbnails === 'boolean') patch.skipThumbnails = body.skipThumbnails;
  if (typeof body.watch === 'boolean') patch.watch = body.watch;
  if (Array.isArray(body.excludes)) {
    patch.excludes = (body.excludes as unknown[]).map((s) => String(s).trim()).filter(Boolean);
  } else if (typeof body.excludes === 'string') {
    patch.excludes = body.excludes.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(body.sourcePaths) && body.sourcePaths.length > 0) {
    try {
      patch.sourcePaths = (body.sourcePaths as string[]).map(resolveSourceMaybeAbsolute);
    } catch {
      return Response.json({ error: 'invalid source path' }, { status: 400 });
    }
  }

  // Reset the upload catalog ONLY when the sources or target ACTUALLY change (its
  // rel paths / Drive target would otherwise no longer line up). A no-op edit —
  // renaming the set, toggling a flag, re-saving the same sources — must NOT clear
  // it, or every edit would force a needless full re-seed on the next run.
  const sourcesChanged =
    !!patch.sourcePaths &&
    (patch.sourcePaths.length !== cur.sourcePaths.length ||
      patch.sourcePaths.some((p, i) => p !== cur.sourcePaths[i]));
  const targetChanged = patch.targetPath != null && patch.targetPath !== cur.targetPath;
  if (sourcesChanged || targetChanged) catalog.clear(id);

  const updated = backupSets.update(id, patch);
  return Response.json({ backupSet: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  backupSets.delete(id);
  catalog.clear(id); // drop the set's upload catalog
  runs.clear(id); // and its run history
  return Response.json({ ok: true });
}
