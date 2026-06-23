import { createFolder, cleanCliError } from '@/server/cli';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { parentPath, name } = body as { parentPath?: string; name?: string };
  if (!parentPath || !name) {
    return Response.json({ error: 'parentPath and name are required' }, { status: 400 });
  }
  // A name passed as a CLI positional that starts with '-' could be misread as a
  // flag. Reject it here (manual folder creation only; backup runs derive folder
  // names from the local tree and never hit this route).
  if (name.startsWith('-') || name.length > 255) {
    return Response.json({ error: "folder name can't start with '-' and must be ≤ 255 chars" }, { status: 400 });
  }
  const res = await createFolder(parentPath, name);
  if (!res.ok) {
    return Response.json({ error: cleanCliError(res.error) }, { status: 502 });
  }
  return Response.json({ ok: true });
}
