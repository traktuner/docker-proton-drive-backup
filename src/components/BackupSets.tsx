'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useToast } from './Toast';

export interface RunRow {
  id: number;
  startedAt: number;
  finishedAt: number;
  status: 'success' | 'error' | 'cancelled';
  message: string | null;
  files: number;
  bytes: number;
}

export interface BackupSet {
  id: string;
  name: string;
  sourcePaths: string[];
  targetPath: string;
  targetSubfolder: string;
  mode: 'add' | 'backup' | 'mirror';
  schedule: 'off' | 'hourly' | 'daily' | 'weekly';
  scheduleHour: number;
  scheduleMinute: number;
  scheduleDow: number;
  excludes: string[];
  lastRunAt: number | null;
  lastStatus: 'never' | 'running' | 'success' | 'error' | 'cancelled';
  lastMessage: string | null;
  nextRunAt?: number | null;
  recentRuns?: RunRow[];
  lastSuccessAt?: number | null;
  progress?: {
    doneFiles: number;
    totalFiles: number;
    doneBytes: number;
    totalBytes: number;
    current: string;
    bytesPerSec?: number;
  } | null;
}

function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** Compact relative time: "just now", "5m ago", "2h ago", "3d ago". */
function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : `${Math.round(d / 7)}w ago`;
}

// Proton signal tokens (see storybook): success → green, error/cancelled → the
// danger red. A run that didn't complete successfully reads as the failure colour.
const RUN_DOT: Record<RunRow['status'], string> = {
  success: 'var(--signal-success)',
  error: 'var(--signal-danger)',
  cancelled: 'var(--signal-danger)',
};

const STATUS_SIGNAL: Record<BackupSet['lastStatus'], string | null> = {
  never: null,
  running: '--signal-warning',
  success: '--signal-success',
  error: '--signal-danger',
  cancelled: null,
};
function statusStyle(s: BackupSet['lastStatus']): CSSProperties {
  const v = STATUS_SIGNAL[s];
  if (!v) return { color: 'var(--text-weak)', background: 'rgb(255 255 255 / 0.05)' };
  return { color: `var(${v})`, background: `color-mix(in srgb, var(${v}) 15%, transparent)` };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Display order Mon→Sun (values stay JS getDay indices: 0=Sun..6=Sat).
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MODE_LABEL = { add: 'add new', backup: 'backup', mirror: 'mirror' } as const;

const pad = (n: number) => String(n).padStart(2, '0');
function scheduleLabel(s: BackupSet): string {
  const t = `${pad(s.scheduleHour)}:${pad(s.scheduleMinute)}`;
  return s.schedule === 'hourly'
    ? `hourly :${pad(s.scheduleMinute)}`
    : s.schedule === 'daily'
      ? `daily ${t}`
      : s.schedule === 'weekly'
        ? `${DOW[s.scheduleDow]} ${t}`
        : 'manual';
}
const targetLabel = (p: string) => (p === '/' ? 'Drive (root)' : `Drive${p}`);

export default function BackupSets({ refreshKey }: { refreshKey: number }) {
  const { toast } = useToast();
  const [sets, setSets] = useState<BackupSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<BackupSet>>({});
  // Ids the user just hit Cancel on — show immediate feedback until the run
  // actually stops (the backend may take a moment to kill the transfer).
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [verifying, setVerifying] = useState<Set<string>>(new Set());
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const load = () =>
    fetch('/api/backup-sets')
      .then((r) => r.json())
      .then((d) => {
        const next: BackupSet[] = d.backupSets ?? [];
        // Toast when a run finishes (running → terminal).
        for (const n of next) {
          const prev = sets.find((s) => s.id === n.id);
          if (prev?.lastStatus === 'running' && n.lastStatus !== 'running') {
            if (n.lastStatus === 'success') toast(`“${n.name}” finished — ${n.lastMessage ?? 'done'}`, 'success');
            else if (n.lastStatus === 'error') toast(`“${n.name}” failed — ${n.lastMessage ?? 'error'}`, 'error');
            else if (n.lastStatus === 'cancelled') toast(`“${n.name}” cancelled`, 'info');
          }
        }
        setSets(next);
        // Drop the cancelling flag once a set is no longer running.
        setCancelling((prev) => {
          if (prev.size === 0) return prev;
          const still = new Set(
            [...prev].filter((id) => next.find((s) => s.id === id)?.lastStatus === 'running'),
          );
          return still.size === prev.size ? prev : still;
        });
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, [refreshKey]);

  useEffect(() => {
    if (!sets.some((s) => s.lastStatus === 'running')) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [sets]);

  const run = async (id: string) => {
    const name = sets.find((s) => s.id === id)?.name;
    setSets((prev) => prev.map((s) => (s.id === id ? { ...s, lastStatus: 'running' } : s)));
    toast(`Running${name ? ` “${name}”` : ''}…`, 'info');
    await fetch(`/api/backup-sets/${id}/run`, { method: 'POST' });
    load();
  };
  const cancel = async (id: string) => {
    setCancelling((prev) => new Set(prev).add(id)); // immediate feedback
    await fetch(`/api/backup-sets/${id}/cancel`, { method: 'POST' });
    load();
  };
  const verify = async (id: string) => {
    const name = sets.find((s) => s.id === id)?.name;
    setVerifying((prev) => new Set(prev).add(id));
    toast(`Verifying${name ? ` “${name}”` : ''} against Drive…`, 'info');
    try {
      const res = await fetch(`/api/backup-sets/${id}/verify`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Verify failed');
      toast(
        d.repaired > 0
          ? `Verify: ${d.repaired} item(s) will re-upload next run (${d.checked} checked)`
          : `Verify: all ${d.checked} item(s) match Drive`,
        d.repaired > 0 ? 'info' : 'success',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setVerifying((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
      load();
    }
  };
  const remove = async (id: string) => {
    const name = sets.find((s) => s.id === id)?.name;
    await fetch(`/api/backup-sets/${id}`, { method: 'DELETE' });
    toast(`Backup set${name ? ` “${name}”` : ''} deleted`, 'info');
    load();
  };
  const startEdit = (s: BackupSet) => {
    setEditId(s.id);
    setDraft({ ...s });
  };
  const saveEdit = async () => {
    if (!editId) return;
    await fetch(`/api/backup-sets/${editId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    setEditId(null);
    toast('Changes saved', 'success');
    load();
  };

  if (loading) return <p className="text-sm text-[color:var(--muted)]">Loading backup sets…</p>;
  if (sets.length === 0)
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[color:var(--border)] px-6 py-10 text-center">
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-[color:var(--panel-2)]">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7h-1" />
            <path d="M9 15l3 -3l3 3" />
            <path d="M12 12l0 9" />
          </svg>
        </span>
        <p className="text-sm font-medium text-[color:var(--text)]">No backup sets yet</p>
        <p className="mt-1 max-w-xs text-xs leading-relaxed text-[color:var(--muted)]">
          Tick folders in <span className="text-[color:var(--text)]">Local files</span>, choose a target in{' '}
          <span className="text-[color:var(--text)]">Proton Drive</span>, then create your first set above.
        </p>
      </div>
    );

  return (
    <ul className="space-y-2">
      {sets.map((s) => {
        const editing = editId === s.id;
        return (
          <li
            key={s.id}
            className="rounded-xl border border-[color:var(--border)] bg-[color:var(--panel-2)]/40 p-3 transition hover:border-[color:var(--border-strong)]"
          >
            {editing ? (
              <div className="space-y-2">
                <input
                  value={draft.name ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  className="w-full pfield px-2 py-1 text-sm"
                />
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <select
                    value={draft.mode}
                    onChange={(e) => setDraft((d) => ({ ...d, mode: e.target.value as BackupSet['mode'] }))}
                    className="pfield px-2 py-1"
                  >
                    <option value="add">add new</option>
                    <option value="backup">backup</option>
                    <option value="mirror">mirror</option>
                  </select>
                  <select
                    value={draft.schedule}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, schedule: e.target.value as BackupSet['schedule'] }))
                    }
                    className="pfield px-2 py-1"
                  >
                    <option value="off">manual</option>
                    <option value="hourly">hourly</option>
                    <option value="daily">daily</option>
                    <option value="weekly">weekly</option>
                  </select>
                  {draft.schedule === 'weekly' && (
                    <select
                      value={draft.scheduleDow}
                      onChange={(e) => setDraft((d) => ({ ...d, scheduleDow: +e.target.value }))}
                      className="pfield px-2 py-1"
                    >
                      {DOW_ORDER.map((i) => (
                        <option key={i} value={i}>
                          {DOW[i]}
                        </option>
                      ))}
                    </select>
                  )}
                  {draft.schedule === 'hourly' && (
                    <span className="flex items-center gap-1">
                      <span className="text-[color:var(--muted)]">at :</span>
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={draft.scheduleMinute}
                        onChange={(e) => setDraft((d) => ({ ...d, scheduleMinute: +e.target.value }))}
                        className="w-12 pfield px-1.5 py-1"
                      />
                    </span>
                  )}
                  {(draft.schedule === 'daily' || draft.schedule === 'weekly') && (
                    <span className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={draft.scheduleHour}
                        onChange={(e) => setDraft((d) => ({ ...d, scheduleHour: +e.target.value }))}
                        className="w-12 pfield px-1.5 py-1"
                      />
                      :
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={draft.scheduleMinute}
                        onChange={(e) => setDraft((d) => ({ ...d, scheduleMinute: +e.target.value }))}
                        className="w-12 pfield px-1.5 py-1"
                      />
                    </span>
                  )}
                </div>
                {draft.mode !== 'add' && (
                  <textarea
                    value={(draft.excludes ?? []).join('\n')}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, excludes: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }))
                    }
                    rows={2}
                    placeholder="Exclude patterns, one per line"
                    className="w-full resize-y pfield px-2 py-1 text-xs"
                  />
                )}
                <div className="flex gap-2">
                  <button onClick={saveEdit} className="pbtn pbtn--solid px-3 py-1.5 text-xs">
                    Save
                  </button>
                  <button onClick={() => setEditId(null)} className="pbtn pbtn--ghost px-3 py-1.5 text-xs">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <span className="rounded px-1.5 py-0.5 text-[11px]" style={statusStyle(s.lastStatus)}>
                      {s.lastStatus}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-[color:var(--muted)]">
                    {s.sourcePaths.length} source{s.sourcePaths.length > 1 ? 's' : ''} →{' '}
                    <span className="text-[color:var(--accent-2)]">
                      {targetLabel(s.targetPath)}/{s.targetSubfolder}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-[color:var(--muted)]">
                    {MODE_LABEL[s.mode]} · {scheduleLabel(s)}
                    {s.schedule !== 'off' && s.nextRunAt && s.lastStatus !== 'running' && (
                      <span className="text-[color:var(--muted)]"> · next {fmtWhen(s.nextRunAt)}</span>
                    )}
                  </p>

                  {/* Trust signal: one dot for the LAST run (colour = its outcome,
                      hover for status/time/message) + whether a success ever happened. */}
                  {(() => {
                    if (s.lastStatus === 'running') return null;
                    const last = s.recentRuns?.[0];
                    const status =
                      last?.status ??
                      (s.lastStatus === 'success' || s.lastStatus === 'error' || s.lastStatus === 'cancelled'
                        ? s.lastStatus
                        : null);
                    if (!status) return null; // never run yet → nothing to show
                    const when = last?.finishedAt ?? s.lastRunAt ?? undefined;
                    const message = last?.message ?? s.lastMessage ?? undefined;
                    const tip = `${status}${when ? ` · ${relTime(when)}` : ''}${message ? ` · ${message}` : ''}`;
                    return (
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[color:var(--muted)]">
                        <span
                          className="h-1.5 w-1.5 shrink-0 cursor-help rounded-full"
                          style={{ background: RUN_DOT[status] }}
                          title={tip}
                        />
                        <span>
                          {s.lastSuccessAt ? `Last success ${relTime(s.lastSuccessAt)}` : 'No successful run yet'}
                        </span>
                      </div>
                    );
                  })()}

                  {s.lastStatus === 'running' && s.progress ? (
                    <div className="mt-1.5">
                      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--panel-2)]">
                        {s.progress.totalBytes ? (
                          <div
                            className="h-full rounded-full bg-[color:var(--accent)] transition-all"
                            style={{ width: `${Math.min(100, (s.progress.doneBytes / s.progress.totalBytes) * 100)}%` }}
                          />
                        ) : (
                          // Streaming catalog engine: total isn't known up front, so a
                          // sliding indeterminate bar signals activity (no fake %).
                          <div className="pd-indeterminate" />
                        )}
                      </div>
                      <p className="tnum mt-1 truncate text-[11px] text-[color:var(--muted)]">
                        {s.progress.totalBytes
                          ? `${s.progress.doneFiles}/${s.progress.totalFiles} files · ${fmtBytes(s.progress.doneBytes)}/${fmtBytes(s.progress.totalBytes)}`
                          : `${s.progress.doneFiles.toLocaleString()} uploaded · ${fmtBytes(s.progress.doneBytes)}`}
                        {s.progress.bytesPerSec ? ` · ${fmtBytes(s.progress.bytesPerSec)}/s` : ''}
                        {' · '}
                        {s.progress.current}
                      </p>
                    </div>
                  ) : (
                    s.lastMessage && (
                      <p className="mt-1 truncate text-xs text-[color:var(--muted)]" title={s.lastMessage}>
                        {s.lastMessage}
                      </p>
                    )
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {confirmDel === s.id ? (
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className="text-[color:var(--muted)]">Delete?</span>
                      <button
                        onClick={() => {
                          setConfirmDel(null);
                          remove(s.id);
                        }}
                        className="pbtn rounded px-2.5 py-1 text-white"
                        style={{ background: 'var(--signal-danger)' }}
                      >
                        Yes
                      </button>
                      <button onClick={() => setConfirmDel(null)} className="pbtn pbtn--ghost px-2.5 py-1">
                        No
                      </button>
                    </span>
                  ) : (
                    <>
                      {s.lastStatus === 'running' ? (
                        <button
                          onClick={() => cancel(s.id)}
                          disabled={cancelling.has(s.id)}
                          className="pbtn pbtn--ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                          style={{ color: 'var(--signal-warning)' }}
                        >
                          {cancelling.has(s.id) && (
                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-[color:var(--border)] border-t-[color:var(--signal-warning)]" />
                          )}
                          {cancelling.has(s.id) ? 'Cancelling…' : 'Cancel'}
                        </button>
                      ) : (
                        <button onClick={() => run(s.id)} className="pbtn pbtn--solid px-3 py-1.5 text-xs">
                          Run
                        </button>
                      )}
                      <button
                        onClick={() => startEdit(s)}
                        disabled={s.lastStatus === 'running'}
                        className="pbtn pbtn--ghost px-2.5 py-1.5 text-xs"
                      >
                        Edit
                      </button>
                      {s.mode !== 'add' && (
                        <button
                          onClick={() => verify(s.id)}
                          disabled={s.lastStatus === 'running' || verifying.has(s.id)}
                          className="pbtn pbtn--ghost px-2.5 py-1.5 text-xs"
                          title="Reconcile the catalog against Drive — re-upload anything deleted or changed there"
                        >
                          {verifying.has(s.id) ? 'Verifying…' : 'Verify'}
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmDel(s.id)}
                        disabled={s.lastStatus === 'running'}
                        className="pbtn pbtn--danger px-2.5 py-1.5 text-xs"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
