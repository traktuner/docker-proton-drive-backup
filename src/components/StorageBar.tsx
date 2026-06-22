'use client';

import { useEffect, useState } from 'react';
import { useAuth } from './AuthProvider';

interface Quota {
  maxSpace: number;
  usedSpace: number;
  driveUsed: number;
}

function fmt(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : v < 100 ? 1 : 0)} ${u[i]}`;
}

export default function StorageBar() {
  const { status: authStatus } = useAuth();
  const [q, setQ] = useState<Quota | null>(null);

  useEffect(() => {
    const load = () =>
      fetch('/api/quota')
        .then((r) => r.json())
        .then((d) => setQ(d.quota))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // Reload immediately when the session is (re)authenticated so the bar — which
    // hides itself on a dead session — comes back without waiting for the interval.
  }, [authStatus]);

  if (!q || !q.maxSpace) return null;
  const pct = Math.min(100, (q.driveUsed / q.maxSpace) * 100);
  // Proton meter: neutral until it gets tight, then warning / danger.
  const color =
    pct >= 90
      ? 'var(--signal-danger)'
      : pct >= 80
        ? 'var(--signal-warning)'
        : 'var(--text-weak)';

  return (
    <div
      className="hidden items-center gap-2 sm:flex"
      title={`Drive ${fmt(q.driveUsed)} of ${fmt(q.maxSpace)} (${pct.toFixed(1)}%)`}
    >
      <div className="h-1.5 w-28 overflow-hidden rounded-full" style={{ background: 'var(--background-strong)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="tnum text-xs">
        <span className="text-[color:var(--text-norm)]">{fmt(q.driveUsed)}</span>
        <span className="text-[color:var(--text-weak)]"> / {fmt(q.maxSpace)}</span>
      </span>
    </div>
  );
}
