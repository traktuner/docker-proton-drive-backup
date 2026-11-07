import { loginStart } from '@/server/drive';

export const dynamic = 'force-dynamic';

/** Start the browser sign-in (Proton session fork). Returns the URL to open. */
export async function POST() {
  const status = await loginStart();
  if (status.state === 'failed') {
    return Response.json({ error: status.error || 'Login failed' }, { status: 500 });
  }
  return Response.json({ state: status.state, signInUrl: status.signInUrl ?? null });
}
