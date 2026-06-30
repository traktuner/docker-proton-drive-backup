import { backupSets } from '@/server/db';
import { previewDelta } from '@/server/engine';
import { uploadsBusy } from '@/server/cli';

export const dynamic = 'force-dynamic';

// One preview at a time across the process (a full local walk can be heavy). On
// globalThis so the flag is shared across route module instances, and so an
// unauthenticated caller can't pile up concurrent walks.
const g = globalThis as unknown as { __pdPreviewing?: boolean };

/**
 * Dry-run a backup/mirror set: report what the next run WOULD upload (new/changed
 * files + bytes) and, for mirror, which Drive items it would trash — without
 * uploading, trashing, or writing anything. Read-only; never contacts Drive.
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
    const res = await previewDelta(id, set.sourcePaths, set.targetSubfolder, set.mode, set.excludes);
    return Response.json(res);
  } finally {
    g.__pdPreviewing = false;
  }
}
