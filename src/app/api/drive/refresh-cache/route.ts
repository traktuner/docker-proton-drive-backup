import { clearTreeCache, uploadsBusy } from '@/server/drive';

export const dynamic = 'force-dynamic';

export async function POST() {
  if (uploadsBusy()) {
    return Response.json({ error: 'A backup is running - resync after it finishes.' }, { status: 409 });
  }
  await clearTreeCache();
  return Response.json({ ok: true });
}
