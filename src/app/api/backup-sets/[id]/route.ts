import { backupSets, type BackupMode, type Schedule } from '@/server/db';
import { sanitizeSegment } from '@/server/local';
import { catalog } from '@/server/catalog';
import { runs } from '@/server/runs';
import { renameDrive, normalizeProtonPath, cleanDriveError, drive, invalidateFolder } from '@/server/drive';
import { claimBackupSet, isBackupSetBusy, releaseBackupSet } from '@/server/backup-lock';

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
  const cur = backupSets.get(id);
  if (!cur) return Response.json({ error: 'not found' }, { status: 404 });
  if (cur.lastStatus === 'running' || !claimBackupSet(id)) {
    return Response.json({ error: 'Pause or stop this backup before editing it.' }, { status: 409 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (Object.hasOwn(body, 'sourcePaths')) {
      return Response.json(
        { error: 'Existing sources cannot be replaced. Add sources with the source picker.' },
        { status: 400 },
      );
    }
    const patch: Parameters<typeof backupSets.update>[1] = {};

    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.targetPath === 'string' && body.targetPath.trim()) patch.targetPath = body.targetPath.trim();
    if (MODES.includes(body.mode as BackupMode)) patch.mode = body.mode as BackupMode;
    if (SCHEDULES.includes(body.schedule as Schedule)) patch.schedule = body.schedule as Schedule;
    if (body.scheduleHour != null) patch.scheduleHour = Math.min(23, Math.max(0, +body.scheduleHour || 0));
    if (body.scheduleMinute != null) patch.scheduleMinute = Math.min(59, Math.max(0, +body.scheduleMinute || 0));
    if (body.scheduleDow != null) patch.scheduleDow = Math.min(6, Math.max(0, +body.scheduleDow || 0));
    if (typeof body.skipThumbnails === 'boolean') patch.skipThumbnails = body.skipThumbnails;
    if (typeof body.includeHidden === 'boolean') patch.includeHidden = body.includeHidden;
    if (Array.isArray(body.excludes)) {
      patch.excludes = (body.excludes as unknown[]).map((s) => String(s).trim()).filter(Boolean);
    } else if (typeof body.excludes === 'string') {
      patch.excludes = body.excludes.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    const targetChanged = patch.targetPath != null && normalizeProtonPath(patch.targetPath) !== normalizeProtonPath(cur.targetPath);

    // --- Validate everything that can be rejected BEFORE mutating anything ---

    // Globally-unique names: reject only when the name is actually CHANGING to one
    // another set already uses. Pre-existing duplicates are tolerated (we never
    // retroactively block editing an old set that happens to share a name).
    if (patch.name && patch.name !== cur.name && backupSets.all().some((s) => s.id !== id && s.name === patch.name)) {
      return Response.json({ error: `Another backup set is already named “${patch.name}”.` }, { status: 409 });
    }

    // Drive subfolder change → rename the Drive folder and rewrite catalog keys so
    // nothing re-uploads. Computed from the (sanitised) requested folder name.
    const newSub =
      typeof body.targetSubfolder === 'string' && body.targetSubfolder.trim()
        ? sanitizeSegment(body.targetSubfolder.trim())
        : undefined;
    const subfolderChanging = !!newSub && newSub !== cur.targetSubfolder;

    if (subfolderChanging) {
      if (targetChanged) {
        return Response.json(
          { error: 'Change the target and the Drive folder in separate steps.' },
          { status: 400 },
        );
      }
      if (backupSets.all().some((s) => s.id !== id && normalizeProtonPath(s.targetPath) === normalizeProtonPath(cur.targetPath) && s.targetSubfolder === newSub)) {
        return Response.json(
          { error: `Another set already uses the Drive folder “${newSub}” under this target.` },
          { status: 409 },
        );
      }
    }

    // A new target must not lead into another set's Drive folder (the run would
    // adopt that folder, and Mirror could trash files the other set relies on).
    if (targetChanged && !subfolderChanging) {
      const sub = cur.targetSubfolder;
      if (backupSets.all().some((s) => s.id !== id && normalizeProtonPath(s.targetPath) === normalizeProtonPath(patch.targetPath!) && s.targetSubfolder === sub)) {
        return Response.json(
          { error: `Another set already uses the Drive folder “${sub}” under that target. Rename this set's Drive folder first.` },
          { status: 409 },
        );
      }
    }

    // --- Mutations (validation passed) ---

    if (subfolderChanging) {
      // Rename the actual Drive folder first. If it fails for any reason other than
      // "it isn't there yet" (set never ran), abort WITHOUT touching the DB/catalog —
      // so a failed rename never desyncs our keys into a full re-upload.
      // Rename by node id when the set is bound to its folder (the folder may have
      // moved name-wise on Drive); fall back to the path for sets that never ran.
      let renamed: { ok: boolean; code: string | null } = { ok: true, code: null };
      if (cur.folderUid) {
        try {
          const node = await (await drive()).rename(cur.folderUid, newSub!);
          invalidateFolder(node.parentUid);
        } catch (e) {
          renamed = { ok: false, code: (e as { code?: string })?.code ?? null };
        }
      } else {
        const res = await renameDrive(`${normalizeProtonPath(cur.targetPath)}/${cur.targetSubfolder}`, newSub!);
        renamed = res.ok ? { ok: true, code: null } : { ok: false, code: res.code };
      }
      // Only an explicit "not found" (set never ran) may proceed without a rename;
      // anything else aborts WITHOUT touching the DB/catalog.
      if (!renamed.ok && renamed.code !== 'NOT_FOUND') {
        return Response.json(
          { error: `Could not rename the Drive folder: ${cleanDriveError(null, renamed.code)}` },
          { status: 502 },
        );
      }
      // Drive folder renamed (or wasn't there yet) → rewrite our catalog keys + the
      // stored subfolder atomically. Next run reuses everything; no re-upload.
      backupSets.renameSubfolder(id, cur.targetSubfolder, newSub!);
    }

    // A Drive target change invalidates the catalog. Source replacement is rejected
    // above; additive source edits use a separate route that preserves the catalog.
    // A subfolder rename rewrites keys above instead of clearing them.
    if (targetChanged) {
      catalog.clear(id);
      backupSets.setFolderUid(id, null);
      backupSets.setSourceMarks(id, {});
    }

    const updated = backupSets.update(id, patch);
    return Response.json({ backupSet: updated });
  } finally {
    releaseBackupSet(id);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (set.lastStatus === 'running' || isBackupSetBusy(id)) {
    return Response.json({ error: 'Pause or stop this backup before deleting it.' }, { status: 409 });
  }
  backupSets.delete(id);
  catalog.clear(id); // drop the set's upload catalog
  runs.clear(id); // and its run history
  return Response.json({ ok: true });
}
