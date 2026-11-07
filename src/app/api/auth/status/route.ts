import { bindingState, boundEmail, currentAccount, isAuthenticated, loginStatus } from '@/server/drive';
import { backupSets } from '@/server/db';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1';
  const authed = await isAuthenticated(force);
  const login = await loginStatus();
  const account = authed ? await currentAccount().catch(() => null) : null;
  const binding = bindingState(account);
  return Response.json({
    authenticated: authed,
    loginState: login.state,
    signInUrl: login.signInUrl ?? null,
    error: login.error ?? null,
    account: account ? { email: account.email, displayName: account.displayName } : null,
    // 'confirm' / 'mismatch' block every writing job until resolved (see drive.ts).
    binding,
    boundEmail: boundEmail(),
    targets:
      binding === 'confirm' || binding === 'mismatch'
        ? backupSets.all().map((s) => ({ name: s.name, target: `${s.targetPath === '/' ? '' : s.targetPath}/${s.targetSubfolder}` }))
        : undefined,
  });
}
