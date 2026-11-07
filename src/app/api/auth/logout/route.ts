import { logout } from '@/server/drive';

export const dynamic = 'force-dynamic';

export async function POST() {
  await logout().catch((e) => console.warn('[logout]', e instanceof Error ? e.message : e));
  return Response.json({ ok: true });
}
