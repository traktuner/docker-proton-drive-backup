'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Footer from '@/components/Footer';

type Phase = 'checking' | 'idle' | 'connecting' | 'awaiting' | 'error';

export default function Onboarding() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('checking');
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated) router.replace('/files');
        else setPhase('idle');
      })
      .catch(() => setPhase('idle'));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [router]);

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const d = await fetch('/api/auth/status?force=1').then((r) => r.json());
        if (d.authenticated) {
          if (pollRef.current) clearInterval(pollRef.current);
          router.replace('/files');
        } else if (d.loginState === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase('error');
          setError(d.error || 'Login failed');
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
  };

  const connect = async () => {
    setPhase('connecting');
    setError(null);
    try {
      const res = await fetch('/api/auth/login', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to start login');
      if (d.signInUrl) {
        setSignInUrl(d.signInUrl);
        setPhase('awaiting');
        window.open(d.signInUrl, '_blank', 'noopener,noreferrer');
        startPolling();
      } else {
        throw new Error('No sign-in URL returned by the CLI');
      }
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyUrl = () => {
    if (!signInUrl) return;
    navigator.clipboard.writeText(signInUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    // Proton account-style radial gradient, scoped to onboarding (the app proper
    // keeps its own flat panel background).
    <div
      className="flex min-h-screen flex-col"
      style={{
        background: 'radial-gradient(#221850 15%, #191333 35%, #0e0d12)',
        backgroundAttachment: 'fixed',
        backgroundRepeat: 'no-repeat',
      }}
    >
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-[color:var(--border)] bg-[color:var(--panel)] p-8 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color:var(--accent)]">
            <svg
              viewBox="0 0 32 32"
              className="h-6 w-6"
              fill="none"
              stroke="#fff"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <g transform="translate(4 4)">
                <path d="M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7h-1" />
                <path d="M9 15l3 -3l3 3" />
                <path d="M12 12l0 9" />
              </g>
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-semibold">Proton Drive Backup</h1>
            <p className="text-sm text-[color:var(--muted)]">Connect your account to begin</p>
          </div>
        </div>

        {phase === 'checking' && (
          <p className="animate-pulse text-sm text-[color:var(--muted)]">Checking session…</p>
        )}

        {(phase === 'idle' || phase === 'connecting') && (
          <>
            <p className="mb-6 text-sm leading-relaxed text-[color:var(--muted)]">
              You&apos;ll be sent to Proton to sign in securely in your browser. The session is
              stored inside the container - no password is ever handled here.
            </p>
            <button
              onClick={connect}
              disabled={phase === 'connecting'}
              className="pbtn pbtn--solid w-full px-4 py-3"
            >
              {phase === 'connecting' ? 'Starting…' : 'Connect Proton Drive'}
            </button>
          </>
        )}

        {phase === 'awaiting' && signInUrl && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--panel-2)] px-3 py-2 text-sm">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[color:var(--accent)]" />
              Waiting for you to finish signing in…
            </div>
            <p className="text-sm text-[color:var(--muted)]">
              A browser tab should have opened. If not, open this URL on any device:
            </p>
            <div className="flex gap-2">
              <a
                href={signInUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 truncate rounded-lg border border-[color:var(--border)] bg-[color:var(--panel-2)] px-3 py-2 text-sm text-[color:var(--accent-2)] hover:underline"
              >
                {signInUrl}
              </a>
              <button
                onClick={copyUrl}
                className="pbtn pbtn--ghost px-3 py-2 text-sm"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
            <button
              onClick={connect}
              className="pbtn pbtn--solid w-full px-4 py-3"
            >
              Try again
            </button>
          </div>
        )}
        </div>
      </div>
      <Footer />
    </div>
  );
}
