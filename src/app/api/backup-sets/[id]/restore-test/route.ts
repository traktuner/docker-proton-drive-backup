import { backupSets } from '@/server/db';
import { restoreTest, specFor } from '@/server/engine';
import { drive, writeGate } from '@/server/drive';

export const dynamic = 'force-dynamic';

// One restore test at a time across the process (it downloads real data).
const g = globalThis as unknown as { __pdRestoreTest?: boolean };

/**
 * Restore test: downloads a random sample of this set's backed-up files from
 * Drive and compares them byte for byte with the local originals. Read-only on
 * Drive and on the catalog, so it may run next to a backup. `?files=` (default
 * 20, at most 200).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const set = backupSets.get(id);
  if (!set) return Response.json({ error: 'not found' }, { status: 404 });
  if (g.__pdRestoreTest) return Response.json({ error: 'A restore test is already running.' }, { status: 409 });
  g.__pdRestoreTest = true;
  try {
    const blocked = await writeGate();
    if (blocked) return Response.json({ error: blocked }, { status: 409 });
    const files = Number(new URL(req.url).searchParams.get('files')) || 20;
    const res = await restoreTest(await drive(), specFor(set), { files });
    return Response.json(res, { status: res.mismatched.length ? 502 : 200 });
  } finally {
    g.__pdRestoreTest = false;
  }
}
