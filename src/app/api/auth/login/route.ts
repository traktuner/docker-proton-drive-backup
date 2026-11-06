import { startLogin } from '@/server/drive';

export const dynamic = 'force-dynamic';

export async function POST() {
  const status = await startLogin().catch(() => ({
    state: 'failed' as const, error: 'Could not start sign-in. Check the Drive backend and its credential store.',
    signInUrl: undefined,
  }));
  if (status.state === 'failed') {
    return Response.json({ error: status.error || 'Login failed' }, { status: 500 });
  }
  return Response.json({
    state: status.state,
    signInUrl: status.signInUrl ?? null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
