import { backupSets } from '@/server/db';
import { previewSet } from '@/server/engine';
import { drive, isAuthenticated, normalizeProtonPath, uploadsBusy } from '@/server/drive';

export const dynamic = 'force-dynamic';

// One preview at a time across the process (a full local walk can be heavy). On
// globalThis so the flag is shared across route module instances, and so an
// unauthenticated caller can't pile up concurrent walks.
const g = globalThis as unknown as { __pdPreviewing?: boolean };

/**
 * Dry-run a backup/mirror set: report what the next run WOULD upload (new/changed
 * files + bytes) and, for mirror, which Drive items it would trash — without
 * uploading, trashing, or writing anything. Same scan and deletion rules as a real
 * run (engine.ts previewSet); reads Drive only for the items it would delete.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (uploadsBusy()) {
    return Response.json({ error: 'A backup is running - preview after it finishes.' }, { status: 409 });
  }
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (set.mode === 'add') {
    return Response.json({ error: 'Preview applies to backup/mirror sets only.' }, { status: 400 });
  }
  if (g.__pdPreviewing) {
    return Response.json({ error: 'A preview is already running - wait for it to finish.' }, { status: 409 });
  }
  g.__pdPreviewing = true;
  try {
    if (set.mode === 'mirror' && !(await isAuthenticated())) {
      return Response.json({ error: 'Sign in to Proton Drive to preview deletions.' }, { status: 401 });
    }
    const res = await previewSet(await drive(), {
      setId: id,
      sourcePaths: set.sourcePaths,
      targetPath: normalizeProtonPath(set.targetPath),
      subfolder: set.targetSubfolder,
      mode: set.mode,
      excludes: set.excludes,
      includeHidden: set.includeHidden,
    });
    return Response.json(res);
  } finally {
    g.__pdPreviewing = false;
  }
}
