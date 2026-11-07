import { listDrive, cleanDriveError } from '@/server/drive';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') || '/';
  const res = await listDrive(path, url.searchParams.get('fresh') === '1');
  if (!res.ok) {
    return Response.json({ error: cleanDriveError(null, res.code) }, { status: res.code === 'NOT_FOUND' ? 404 : 502 });
  }
  return Response.json({ path, entries: res.data });
}
