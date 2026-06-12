import { clearTreeCache, uploadsBusy } from '@/server/cli';

export const dynamic = 'force-dynamic';

export async function POST() {
  if (uploadsBusy()) {
    return Response.json({ error: 'A backup is running - resync after it finishes.' }, { status: 409 });
  }
  clearTreeCache();
  return Response.json({ ok: true });
}
