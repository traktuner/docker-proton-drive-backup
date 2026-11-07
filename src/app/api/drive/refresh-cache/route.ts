import { invalidateFolder, runtime } from '@/server/drive';

export const dynamic = 'force-dynamic';

/** Drop cached Drive listings/metadata so the next browse reads fresh from Drive. */
export async function POST() {
  invalidateFolder();
  await (await runtime()).clearCaches();
  return Response.json({ ok: true });
}
