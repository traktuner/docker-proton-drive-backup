import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { drive, cleanDriveError } from '@/server/drive';

export const dynamic = 'force-dynamic';

/**
 * Download (decrypt + verify) one revision. OFF unless PDB_ENABLE_DOWNLOAD=1:
 * the web UI has no authentication of its own (see README → Security), and this
 * would let anyone who can reach the port read Drive content. Used by the live
 * round-trip test (test/live).
 */
export async function GET(req: Request) {
  if (process.env.PDB_ENABLE_DOWNLOAD !== '1') return Response.json({ error: 'disabled' }, { status: 404 });
  const rev = new URL(req.url).searchParams.get('revision');
  if (!rev) return Response.json({ error: 'revision is required' }, { status: 400 });
  const d = await drive();
  if (!d.download) return Response.json({ error: 'not supported' }, { status: 501 });
  const tmp = path.join(os.tmpdir(), `pdb-dl-${process.pid}-${Date.now()}`);
  try {
    await d.download(rev, tmp);
    const stream = fs.createReadStream(tmp);
    stream.on('close', () => fs.rm(tmp, { force: true }, () => {}));
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { 'content-type': 'application/octet-stream' } });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return Response.json({ error: cleanDriveError(e) }, { status: 502 });
  }
}
