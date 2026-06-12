import { loginManager, clearAuthCache } from '@/server/cli';

export const dynamic = 'force-dynamic';

export async function POST() {
  clearAuthCache();
  const status = await loginManager.start();
  if (status.state === 'failed') {
    return Response.json({ error: status.error || 'Login failed' }, { status: 500 });
  }
  return Response.json({
    state: status.state,
    signInUrl: status.signInUrl ?? null,
  });
}
