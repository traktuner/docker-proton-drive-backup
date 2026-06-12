import { createFolder } from '@/server/cli';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { parentPath, name } = body as { parentPath?: string; name?: string };
  if (!parentPath || !name) {
    return Response.json({ error: 'parentPath and name are required' }, { status: 400 });
  }
  const res = await createFolder(parentPath, name);
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: 502 });
  }
  return Response.json({ ok: true });
}
