'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes } from '@/lib/format';

interface Info {
  app: string;
  imageTag: string;
  cli: string;
  tz: string;
  localRoot: string;
  dataDir: string;
  account: { email: string | null; displayName: string | null };
  quota: { maxSpace: number; usedSpace: number; driveUsed: number } | null;
  productUsed: Record<string, number>;
  uploads: { thresholdMB: number; concurrency: number };
}
interface Updates {
  cli: { current: string; latest: string; updateAvailable: boolean };
  container: { current: string; latest: string | null; updateAvailable: boolean };
}

const fmt = (n: number) => formatBytes(n, 'precise');

function Gear() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-[color:var(--muted)]">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-white/[0.07] px-5 py-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--muted)]">{title}</h3>
      {children}
    </div>
  );
}

export default function Settings() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [updates, setUpdates] = useState<Updates | null>(null);
  const [checking, setChecking] = useState(false);
  const [uploads, setUploads] = useState<{ thresholdMB: number; concurrency: number } | null>(null);
  const [thresholdStr, setThresholdStr] = useState('');

  const saveUploads = (patch: { thresholdMB?: number; concurrency?: number }) => {
    setUploads((u) => (u ? { ...u, ...patch } : u));
    fetch('/api/settings/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then((r) => r.json())
      .then(setUploads)
      .catch(() => {});
  };

  // Parallel-upload size threshold, clamped + persisted on every change.
  const THRESHOLD_MIN = 1;
  const THRESHOLD_MAX = 10000;
  const THRESHOLD_STEP = 5;
  const thresholdNum = parseInt(thresholdStr, 10) || 20;
  const commitThreshold = (v: number) => {
    const c = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, v));
    setThresholdStr(String(c));
    saveUploads({ thresholdMB: c });
  };

  useEffect(() => setMounted(true), []);

  // Prefetch settings on mount so the first open renders at its full size instead
  // of growing as the Storage/Uploads sections load in. The open effect below
  // still refreshes the data each time.
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        setInfo(d);
        setUploads(d.uploads);
        setThresholdStr(String(d.uploads?.thresholdMB ?? 20));
      })
      .catch(() => {});
  }, []);

  // Animate the exit (Proton dialog scale-out) before unmounting. We unmount on
  // the dialog's animationend (see onAnimationEnd below) rather than a fixed
  // timer: on slower mobile devices a 200ms timer can fire before the animation
  // is even applied, so the close looked instant. A longer timer is a fallback in
  // case animationend never fires.
  const finishClose = useCallback(() => {
    setOpen(false);
    setClosing(false);
  }, []);
  const requestClose = useCallback(() => {
    setClosing(true);
    setTimeout(finishClose, 400);
  }, [finishClose]);

  // Lock background scroll while the modal is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const checkUpdates = useCallback(() => {
    setChecking(true);
    setUpdates(null);
    fetch('/api/settings/check-updates')
      .then((r) => r.json())
      .then(setUpdates)
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        setInfo(d);
        setUploads(d.uploads);
        setThresholdStr(String(d.uploads?.thresholdMB ?? 20));
      })
      .catch(() => {});
    checkUpdates();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && requestClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, checkUpdates, requestClose]);

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/onboarding';
  };

  const products = info
    ? Object.entries(info.productUsed)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
    : [];

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Settings"
        className="pbtn h-9 w-9 bg-[color:var(--panel-2)] text-[color:var(--muted)] hover:bg-[color:var(--background-strong)] hover:text-[color:var(--text)]"
      >
        <Gear />
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            className={`proton-modal ${closing ? 'proton-modal--out' : ''} fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 sm:items-center`}
            style={{ background: 'var(--backdrop-norm)', backdropFilter: 'blur(0.5rem)', WebkitBackdropFilter: 'blur(0.5rem)' }}
            onClick={requestClose}
          >
            <div
              className={`proton-dialog ${closing ? 'proton-dialog--out' : ''} my-auto w-full max-w-lg overflow-hidden rounded-xl border border-[color:var(--border)] bg-[color:var(--panel)] text-[color:var(--text)]`}
              style={{ boxShadow: 'var(--shadow-lifted)' }}
              onAnimationEnd={(e) => {
                // Matches both the normal scale-out and the reduce-motion fade-out.
                if (closing && e.animationName.endsWith('-out')) finishClose();
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div>
            <div className="flex items-center justify-between px-5 py-4">
              <h2 className="text-base font-semibold">Settings</h2>
              <button
                onClick={requestClose}
                className="pbtn pbtn--ghost p-1.5 text-[color:var(--muted)] hover:text-[color:var(--text)]"
              >
                ✕
              </button>
            </div>

            {/* Account */}
            <Section title="Account">
              <Row label="Signed in as">
                {info?.account.email ?? <span className="text-[color:var(--muted)]">…</span>}
              </Row>
              <button onClick={logout} className="pbtn pbtn--danger mt-2 w-full px-4 py-2 text-sm">
                Log out
              </button>
            </Section>

            {/* Updates */}
            <Section title="Updates">
              <Row label="Proton Drive CLI">
                {!updates ? (
                  <span className="text-[color:var(--muted)]">{checking ? 'checking…' : '-'}</span>
                ) : updates.cli.updateAvailable ? (
                  <span className="text-amber-300">
                    {updates.cli.current} → {updates.cli.latest} available
                  </span>
                ) : (
                  <span className="text-emerald-300">{updates.cli.current} · up to date</span>
                )}
              </Row>
              <Row label="Container image">
                {!updates ? (
                  <span className="text-[color:var(--muted)]">{checking ? 'checking…' : '-'}</span>
                ) : updates.container.updateAvailable ? (
                  <span className="text-amber-300">update available - {updates.container.latest}</span>
                ) : updates.container.latest ? (
                  <span className="text-emerald-300">{updates.container.current} · up to date</span>
                ) : (
                  <span className="text-[color:var(--muted)]">{updates.container.current}</span>
                )}
              </Row>
              <button
                onClick={checkUpdates}
                disabled={checking}
                className="pbtn pbtn--ghost mt-2 px-3 py-1.5 text-xs text-[color:var(--muted)] hover:text-[color:var(--text)]"
              >
                {checking ? 'Checking…' : 'Check again'}
              </button>
            </Section>

            {/* Uploads */}
            {uploads && (
              <Section title="Uploads">
                <Row label="Upload in parallel under">
                  <span className="inline-flex items-center gap-2">
                    <span className="pstepper text-sm">
                      <button
                        type="button"
                        aria-label="Decrease threshold"
                        disabled={thresholdNum <= THRESHOLD_MIN}
                        onClick={() => commitThreshold(thresholdNum - THRESHOLD_STEP)}
                        className="pstepper__btn"
                      >
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                          <path d="M3.5 8h9" />
                        </svg>
                      </button>
                      <input
                        inputMode="numeric"
                        value={thresholdStr}
                        onChange={(e) => setThresholdStr(e.target.value.replace(/[^0-9]/g, ''))}
                        onBlur={() => commitThreshold(thresholdNum)}
                        className="pstepper__input py-1.5"
                      />
                      <button
                        type="button"
                        aria-label="Increase threshold"
                        disabled={thresholdNum >= THRESHOLD_MAX}
                        onClick={() => commitThreshold(thresholdNum + THRESHOLD_STEP)}
                        className="pstepper__btn"
                      >
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                          <path d="M8 3.5v9M3.5 8h9" />
                        </svg>
                      </button>
                    </span>
                    <span className="text-[color:var(--muted)]">MB</span>
                  </span>
                </Row>
                <div className="py-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-[color:var(--muted)]">Small-file concurrency</span>
                    <span>
                      {uploads.concurrency} simultaneous · {uploads.concurrency <= 4 ? 1 : 2} worker
                      {uploads.concurrency <= 4 ? '' : 's'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={8}
                    value={uploads.concurrency}
                    onChange={(e) => saveUploads({ concurrency: +e.target.value })}
                    className="prange mt-2 w-full"
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--muted)]">
                    Files below the threshold upload in parallel (smallest first); larger files go one at
                    a time. The CLI runs ~4 streams per worker - 4 = one worker, 8 = two.
                  </p>
                </div>
              </Section>
            )}

            {/* Storage */}
            {info?.quota && (
              <Section title="Storage">
                <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-[color:var(--panel-2)]">
                  <div
                    className="h-full rounded-full bg-[color:var(--accent)]"
                    style={{ width: `${Math.min(100, (info.quota.usedSpace / info.quota.maxSpace) * 100)}%` }}
                  />
                </div>
                <Row label="Total used">
                  {fmt(info.quota.usedSpace)} / {fmt(info.quota.maxSpace)}
                </Row>
                {products.map(([k, v]) => (
                  <Row key={k} label={k}>
                    {fmt(v)}
                  </Row>
                ))}
              </Section>
            )}

            {/* Environment */}
            <Section title="Environment">
              <Row label="Timezone">{info?.tz ?? '-'}</Row>
              <Row label="Sources mount">{info?.localRoot ?? '-'}</Row>
              <Row label="Data dir">{info?.dataDir ?? '-'}</Row>
            </Section>

            {/* About — versions live in the Updates section above to avoid duplication. */}
            <Section title="About">
              <div className="flex gap-3 text-xs">
                <a
                  href="https://github.com/traktuner/docker-proton-drive-backup"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[color:var(--accent-2)] hover:underline"
                >
                  GitHub repo
                </a>
                <a
                  href="https://proton.me/support/drive-cli"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[color:var(--accent-2)] hover:underline"
                >
                  Proton Drive CLI docs
                </a>
              </div>
            </Section>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
