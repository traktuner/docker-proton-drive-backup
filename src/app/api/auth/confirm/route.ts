import { confirmBinding, currentAccount } from '@/server/drive';

export const dynamic = 'force-dynamic';

/**
 * Confirm that the signed-in Proton account is the one the backup sets write to.
 * `{ rebind: true }` switches every set to a different account (resets catalogs).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { rebind?: boolean; email?: string };
  const acc = await currentAccount();
  if (!acc) return Response.json({ error: 'Not signed in' }, { status: 401 });
  // The client echoes the address it showed, so a stale page can't confirm another account.
  if (body.email !== undefined && body.email !== acc.email) {
    return Response.json({ error: 'The signed-in account changed — reload and check again.' }, { status: 409 });
  }
  try {
    confirmBinding(acc, body.rebind === true);
  } catch {
    return Response.json({ error: 'Signed in to a different account than your backup sets use.' }, { status: 409 });
  }
  return Response.json({ ok: true });
}
