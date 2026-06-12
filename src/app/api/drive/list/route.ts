import { listDriveCached } from '@/server/cli';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get('path') || '/';
  const res = await listDriveCached(path);
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: 502 });
  }
  return Response.json({ path, entries: res.data });
}
