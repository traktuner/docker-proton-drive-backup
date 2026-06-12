import { runCli, loginManager, clearAuthCache } from '@/server/cli';

export const dynamic = 'force-dynamic';

export async function POST() {
  await runCli(['auth', 'logout'], 30_000).catch(() => {});
  loginManager.reset();
  clearAuthCache();
  return Response.json({ ok: true });
}
