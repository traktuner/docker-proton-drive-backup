import { createFolder, cleanDriveError } from '@/server/drive';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { parentPath, name } = body as { parentPath?: string; name?: string };
  if (!parentPath || !name) {
    return Response.json({ error: 'parentPath and name are required' }, { status: 400 });
  }
  if (name.includes('/') || name === '.' || name === '..' || name.length > 255) {
    return Response.json({ error: "folder name can't contain '/' and must be ≤ 255 chars" }, { status: 400 });
  }
  const res = await createFolder(parentPath, name);
  if (!res.ok) {
    return Response.json({ error: cleanDriveError(null, res.code) }, { status: 502 });
  }
  return Response.json({ ok: true });
}
