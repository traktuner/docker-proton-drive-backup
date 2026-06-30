import { backupSets, type BackupMode, type Schedule } from '@/server/db';
import { resolveLocal } from '@/server/local';
import { progress } from '@/server/progress';
import { computeNextRun } from '@/server/scheduler';
import { runs } from '@/server/runs';

export const dynamic = 'force-dynamic';

const MODES: BackupMode[] = ['add', 'backup', 'mirror'];
const SCHEDULES: Schedule[] = ['off', 'hourly', 'daily', 'weekly'];

function excludesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split('\n').map((s) => s.trim()).filter(Boolean);
  return [];
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export async function GET() {
  const sets = backupSets.all().map((s) => ({
    ...s,
    progress: progress.get(s.id) ?? null,
    nextRunAt: computeNextRun(s),
    recentRuns: runs.recent(s.id, 8),
    lastSuccessAt: runs.lastSuccessAt(s.id),
  }));
  return Response.json({ backupSets: sets, tz: process.env.TZ || 'UTC' });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { name, sourcePaths, targetPath, mode, schedule } = body as Record<string, unknown>;

  if (!(typeof name === 'string') || !name.trim()) {
    return Response.json({ error: 'name is required' }, { status: 400 });
  }
  // Names must be globally unique (the user relies on the name to tell sets apart).
  if (backupSets.all().some((s) => s.name === name.trim())) {
    return Response.json({ error: `A backup set named “${name.trim()}” already exists.` }, { status: 409 });
  }
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    return Response.json({ error: 'at least one source path is required' }, { status: 400 });
  }
  if (!(typeof targetPath === 'string') || !targetPath.trim()) {
    return Response.json({ error: 'targetPath is required' }, { status: 400 });
  }

  let resolved: string[];
  try {
    resolved = (sourcePaths as string[]).map((p) => resolveLocal(p));
  } catch {
    return Response.json({ error: 'invalid source path' }, { status: 400 });
  }

  const targetFolder = (body as any).targetFolder;
  const created = backupSets.create({
    name: name.trim(),
    sourcePaths: resolved,
    targetPath: targetPath.trim(),
    // Optional explicit Drive subfolder; db.create sanitises and de-dupes per target.
    targetSubfolder: typeof targetFolder === 'string' && targetFolder.trim() ? targetFolder.trim() : undefined,
    mode: MODES.includes(mode as BackupMode) ? (mode as BackupMode) : 'add',
    schedule: SCHEDULES.includes(schedule as Schedule) ? (schedule as Schedule) : 'off',
    scheduleHour: clampInt((body as any).scheduleHour, 0, 23, 3),
    scheduleMinute: clampInt((body as any).scheduleMinute, 0, 59, 0),
    scheduleDow: clampInt((body as any).scheduleDow, 0, 6, 1),
    excludes: excludesOf((body as any).excludes),
  });
  return Response.json({ backupSet: created }, { status: 201 });
}
