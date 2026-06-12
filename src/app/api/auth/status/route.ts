import { isAuthenticated, loginManager } from '@/server/cli';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  const authed = await isAuthenticated(force);
  const login = loginManager.status();
  return Response.json({
    authenticated: authed,
    loginState: login.state,
    signInUrl: login.signInUrl ?? null,
    error: login.error ?? null,
  });
}
