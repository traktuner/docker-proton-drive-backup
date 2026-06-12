import { listLocal, LOCAL_ROOT } from '@/server/local';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get('path') || '/';
  try {
    const entries = await listLocal(path);
    return Response.json({ path, root: LOCAL_ROOT, entries });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
