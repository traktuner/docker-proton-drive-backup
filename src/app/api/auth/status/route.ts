import { authStatus } from '@/server/drive';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  return Response.json(await authStatus(force), { headers: { 'Cache-Control': 'no-store' } });
}
