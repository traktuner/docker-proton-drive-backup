'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './AuthProvider';
import { useToast } from './Toast';

interface Status {
  binding: 'none' | 'ok' | 'confirm' | 'mismatch';
  account: { email: string | null } | null;
  boundEmail: string | null;
  targets?: { name: string; target: string }[];
}

/**
 * Shown when backups must not write yet because the Proton account is not
 * confirmed: after a new sign-in on an installation that already has backup sets
 * (the old session could not be taken over), or when a DIFFERENT account is
 * signed in than the one the sets were created with. Until resolved, every run
 * and scheduled run is refused with the same explanation (server: writeGate).
 */
export default function AccountBanner() {
  const { status } = useAuth();
  const { toast } = useToast();
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then(setSt)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (status === 'authenticated') load();
  }, [status, load]);

  if (!st || status !== 'authenticated' || (st.binding !== 'confirm' && st.binding !== 'mismatch')) return null;
  const email = st.account?.email ?? 'this account';

  const confirm = async (rebind: boolean) => {
    if (rebind && !window.confirm(`Switch every backup set to ${email}? Their catalogs are reset and the next runs upload everything into this account.`)) return;
    setBusy(true);
    try {
      const r = await fetch('/api/auth/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: st.account?.email ?? undefined, rebind }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not confirm');
      toast(`Backups now write to ${email}`, 'success');
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="alert" className="border-b px-4 py-3 text-sm" style={{ background: 'color-mix(in srgb, var(--signal-warn, #f59e0b) 12%, var(--panel))', borderColor: 'var(--border)' }}>
      {st.binding === 'confirm' ? (
        <>
          <p className="text-[color:var(--text)]">
            Signed in as <strong>{email}</strong>. Confirm that your backup sets should write to this Proton account — backups wait until you do.
          </p>
          {st.targets && st.targets.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-[0.8125rem] text-[color:var(--muted)]">
              {st.targets.map((t) => (
                <li key={t.name}>
                  {t.name} → Drive{t.target}
                </li>
              ))}
            </ul>
          )}
          <button disabled={busy} onClick={() => confirm(false)} className="pbtn pbtn--solid mt-2 px-3 py-1 text-[0.8125rem]">
            Use {email} for these backups
          </button>
        </>
      ) : (
        <>
          <p className="text-[color:var(--text)]">
            Signed in as <strong>{email}</strong>, but your backup sets belong to <strong>{st.boundEmail ?? 'another account'}</strong>. Nothing is written until this is resolved.
          </p>
          <p className="mt-1 text-[0.8125rem] text-[color:var(--muted)]">Sign out and sign in with {st.boundEmail ?? 'the original account'}, or switch all sets to this account (they upload everything again).</p>
          <button disabled={busy} onClick={() => confirm(true)} className="pbtn pbtn--danger mt-2 px-3 py-1 text-[0.8125rem]">
            Switch all sets to {email}
          </button>
        </>
      )}
    </div>
  );
}
