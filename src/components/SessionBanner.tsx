'use client';

import { useAuth } from './AuthProvider';

/**
 * Persistent top bar shown when the Proton session has expired (or is being
 * reconnected). Unlike a toast it does not auto-dismiss — it stays until the
 * session is back. It reconnects IN PLACE (AuthProvider opens a Proton tab and
 * polls), so the page never navigates away and no in-progress work is lost.
 */
export default function SessionBanner() {
  const { status, signInUrl, reconnect } = useAuth();

  if (status !== 'expired' && status !== 'reconnecting') return null;
  const reconnecting = status === 'reconnecting';

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2.5 text-sm"
      style={{
        background: 'color-mix(in srgb, var(--signal-danger) 14%, var(--panel))',
        borderColor: 'color-mix(in srgb, var(--signal-danger) 40%, var(--border))',
      }}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${reconnecting ? 'animate-pulse' : ''}`}
        style={{ background: 'var(--signal-danger)' }}
      />
      <span className="min-w-0 flex-1 text-[color:var(--text)]">
        {reconnecting ? (
          <>Reconnecting to Proton Drive — finish signing in in the new tab.</>
        ) : (
          <>
            Your Proton session expired — reconnect to keep backing up.{' '}
            <span className="text-[color:var(--muted)]">
              Your saved backup sets are safe and nothing was deleted.
            </span>
          </>
        )}
      </span>

      {reconnecting && signInUrl ? (
        <a
          href={signInUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 underline decoration-dotted underline-offset-2 hover:no-underline"
          style={{ color: 'var(--accent-2)' }}
        >
          Open sign-in
        </a>
      ) : (
        <button
          onClick={reconnect}
          className="pbtn pbtn--solid shrink-0 px-3 py-1 text-xs"
        >
          Reconnect
        </button>
      )}
    </div>
  );
}
