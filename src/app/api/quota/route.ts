import { getQuota } from '@/server/quota';

export const dynamic = 'force-dynamic';

export async function GET() {
  const quota = await getQuota();
  return Response.json({ quota });
}
