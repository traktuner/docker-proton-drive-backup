import { drive, resolvePath, cleanDriveError } from '@/server/drive';
import { driveErrorCode } from '@/server/proton/types';

export const dynamic = 'force-dynamic';

/**
 * Revisions of a Drive file (newest first) with the size and SHA-1 Drive stores.
 * Read-only. Used by the live round-trip test and for diagnostics.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams.get('path');
  if (!p) return Response.json({ error: 'path is required' }, { status: 400 });
  try {
    const node = await resolvePath(p, true);
    if (!node || node.kind !== 'file') return Response.json({ error: 'Not found on Drive.' }, { status: 404 });
    const d = await drive();
    return Response.json({ node, revisions: d.revisions ? await d.revisions(node.uid) : [] });
  } catch (e) {
    return Response.json({ error: cleanDriveError(e) }, { status: driveErrorCode(e) === 'UNAUTHENTICATED' ? 401 : 502 });
  }
}
