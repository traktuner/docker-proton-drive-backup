import { backupSets, type BackupMode, type Schedule } from '@/server/db';
import { resolveLocal } from '@/server/local';
import { catalog } from '@/server/catalog';
import { runs } from '@/server/runs';

export const dynamic = 'force-dynamic';

const MODES: BackupMode[] = ['add', 'backup', 'mirror'];
const SCHEDULES: Schedule[] = ['off', 'hourly', 'daily', 'weekly'];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json({ backupSet: set });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!backupSets.get(id)) return Response.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Parameters<typeof backupSets.update>[1] = {};

  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.targetPath === 'string' && body.targetPath.trim()) patch.targetPath = body.targetPath.trim();
  if (MODES.includes(body.mode as BackupMode)) patch.mode = body.mode as BackupMode;
  if (SCHEDULES.includes(body.schedule as Schedule)) patch.schedule = body.schedule as Schedule;
  if (body.scheduleHour != null) patch.scheduleHour = Math.min(23, Math.max(0, +body.scheduleHour || 0));
  if (body.scheduleMinute != null) patch.scheduleMinute = Math.min(59, Math.max(0, +body.scheduleMinute || 0));
  if (body.scheduleDow != null) patch.scheduleDow = Math.min(6, Math.max(0, +body.scheduleDow || 0));
  if (Array.isArray(body.excludes)) {
    patch.excludes = (body.excludes as unknown[]).map((s) => String(s).trim()).filter(Boolean);
  } else if (typeof body.excludes === 'string') {
    patch.excludes = body.excludes.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(body.sourcePaths) && body.sourcePaths.length > 0) {
    try {
      patch.sourcePaths = (body.sourcePaths as string[]).map((p) => resolveLocal(p));
    } catch {
      return Response.json({ error: 'invalid source path' }, { status: 400 });
    }
  }

  // Changing where files come from or go invalidates the upload catalog (its rel
  // paths / Drive target no longer line up), so reset it — the next run rebuilds.
  if (patch.sourcePaths || patch.targetPath) catalog.clear(id);

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
