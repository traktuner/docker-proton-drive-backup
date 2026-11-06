import { logout, uploadsBusy } from '@/server/drive';
import { clearUserInfo } from '@/server/quota';

export const dynamic = 'force-dynamic';

export async function POST() {
  if (uploadsBusy()) return Response.json({ error: 'Finish or cancel the running backup before signing out.' }, { status: 409 });
  try {
    await logout();
  } catch {
    return Response.json({ error: 'Could not sign out. Wait for Drive operations to finish and try again.' }, { status: 503 });
  }
  clearUserInfo();
  return Response.json({ ok: true });
}
