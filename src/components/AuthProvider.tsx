'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useToast } from './Toast';
import SessionBanner from './SessionBanner';

/**
 * Single source of truth for "is the Proton session alive?" on the client.
 *
 * The app derives auth from several independent server signals that used to drift
 * apart (a hardcoded "Connected" badge, a one-time onboarding gate, the Drive pane's
 * own error). This provider replaces that with ONE reactive state:
 *  - polls /api/auth/status (the server now reports the truth — a dead session no
 *    longer hides behind the in-memory "authenticated" flag),
 *  - lets any component report an auth-looking error to flip the state immediately,
 *  - drives a persistent reconnect banner + a real "Connected/Reconnect" badge,
 *  - reconnects IN PLACE (new Proton tab + polling) so the page never unmounts and
 *    no in-progress work (the backup-set builder form) is lost.
 *
 * Saved backup sets live server-side in SQLite and are never touched by any of this.
 */

export type AuthStatus = 'unknown' | 'authenticated' | 'expired' | 'reconnecting';

interface AuthApi {
  status: AuthStatus;
  signInUrl: string | null;
  /** Begin an in-place reconnect: opens Proton sign-in in a new tab and polls. */
  reconnect: () => void;
  /** A real operation hit an auth-looking error — verify the session right now. */
  reportAuthError: (text?: string) => void;
}

const Ctx = createContext<AuthApi | null>(null);

/** Subscribe to the shared auth state. Safe no-op shape if no provider is mounted. */
export function useAuth(): AuthApi {
  return (
    useContext(Ctx) ?? {
      status: 'unknown',
      signInUrl: null,
      reconnect: () => {},
      reportAuthError: () => {},
    }
  );
}

// Client-side mirror of the server's auth-error patterns (cli.ts AUTH_ERROR_PATTERNS),
// plus the friendly messages this app produces, so a raw CLI error or our own
// "session expired" text both count.
const AUTH_HINTS = [
  'no session',
  'please login',
  'not authenticated',
  'not signed',
  'unauthor',
  'session expired',
  'err_secrets',
];

/** True if an error string looks like an expired/missing Proton session. */
export function looksLikeAuthError(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return AUTH_HINTS.some((h) => t.includes(h));
}

// Routes that manage their own auth UI — never show the global banner there.
const SELF_MANAGED = new Set(['/onboarding', '/']);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const pathname = usePathname();
  const selfManaged = SELF_MANAGED.has(pathname);

  const [status, setStatus] = useState<AuthStatus>('unknown');
  const [signInUrl, setSignInUrl] = useState<string | null>(null);

  const prevStatus = useRef<AuthStatus>('unknown');
  const reconnectPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectInFlight = useRef(false);

  // One probe of the truthful status endpoint. force=1 bypasses the server's short
  // probe cache for an immediate ground-truth answer (used on focus / reconnect /
  // reported error); the periodic poll uses the cheap cached path.
  const check = useCallback(
    async (
      force = false,
    ): Promise<{ authenticated: boolean; loginState: string; signInUrl: string | null; error: string | null } | null> => {
      try {
        const d = await fetch(`/api/auth/status${force ? '?force=1' : ''}`).then((r) => r.json());
        setStatus(d.authenticated ? 'authenticated' : d.loginState === 'awaiting' ? 'reconnecting' : 'expired');
        if (d.authenticated) setSignInUrl(null);
        else if (d.signInUrl) setSignInUrl(d.signInUrl);
        return d;
      } catch {
        return null; // network blip — keep the last known status, try again next tick
      }
    },
    [],
  );

  // Surface recovery: when the session comes back, confirm it and tidy up.
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (!selfManaged && status === 'authenticated' && (prev === 'expired' || prev === 'reconnecting')) {
      toast('Reconnected to Proton Drive', 'success');
      setSignInUrl(null);
    }
  }, [status, toast, selfManaged]);

  // The single poll. The periodic tick is FORCED (re-verifies against the server)
  // so a session that expires silently while the tab sits open + focused is still
  // caught — otherwise the cheap path would trust the sticky flag forever. The
  // initial read is cheap (trusts a just-completed login); focus/visibility also
  // force. Disabled on self-managed routes (onboarding/root), where we also tear
  // down any reconnect poll so nothing keeps running after navigating there.
  useEffect(() => {
    if (selfManaged) {
      if (reconnectPoll.current) {
        clearInterval(reconnectPoll.current);
        reconnectPoll.current = null;
      }
      return;
    }
    check(false);
    const id = setInterval(() => check(true), 60_000);
    const onFocus = () => check(true);
    const onVis = () => {
      if (document.visibilityState === 'visible') check(true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [selfManaged, check]);

  useEffect(
    () => () => {
      if (reconnectPoll.current) clearInterval(reconnectPoll.current);
    },
    [],
  );

  const reportAuthError = useCallback(
    (text?: string) => {
      // Only act on auth-looking errors; verify against the server rather than
      // flipping blindly, so a stray message can't show a false "expired".
      if (text !== undefined && !looksLikeAuthError(text)) return;
      check(true);
    },
    [check],
  );

  const reconnect = useCallback(async () => {
    // Ignore repeat clicks during the POST→signInUrl window so we don't open
    // multiple Proton sign-in tabs.
    if (reconnectInFlight.current) return;
    reconnectInFlight.current = true;
    setStatus('reconnecting');
    try {
      const d = await fetch('/api/auth/login', { method: 'POST' }).then((r) => r.json());
      if (!d.signInUrl) throw new Error(d.error || 'Could not start Proton sign-in');
      setSignInUrl(d.signInUrl);
      // Open Proton in a new tab. May be popup-blocked after the await — the banner
      // also renders this URL as a clickable link as a fallback.
      window.open(d.signInUrl, '_blank', 'noopener,noreferrer');
      if (reconnectPoll.current) clearInterval(reconnectPoll.current);
      reconnectPoll.current = setInterval(async () => {
        const s = await check(true);
        if (s?.authenticated) {
          if (reconnectPoll.current) clearInterval(reconnectPoll.current);
          reconnectPoll.current = null;
        } else if (s?.loginState === 'failed') {
          if (reconnectPoll.current) clearInterval(reconnectPoll.current);
          reconnectPoll.current = null;
          setStatus('expired');
          toast(s.error || 'Sign-in failed — try again', 'error');
        } else {
          // Still signing in (awaiting) or a transient probe blip — hold on
          // "Reconnecting…" rather than flashing the red "expired" banner.
          setStatus('reconnecting');
        }
      }, 2500);
    } catch (e) {
      setStatus('expired');
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      reconnectInFlight.current = false;
    }
  }, [check, toast]);

  return (
    <Ctx.Provider value={{ status, signInUrl, reconnect, reportAuthError }}>
      {!selfManaged && <SessionBanner />}
      {children}
    </Ctx.Provider>
  );
}
