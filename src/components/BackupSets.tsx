'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useToast } from './Toast';
import { useAuth } from './AuthProvider';
import { formatBytes } from '@/lib/format';
import { DOW, DOW_ORDER, pad } from '@/lib/schedule';

export interface SkippedFile {
  rel: string;
  reason: string;
}
export interface RunRow {
  id: number;
  startedAt: number;
  finishedAt: number;
  status: 'success' | 'error' | 'cancelled';
  message: string | null;
  files: number;
  bytes: number;
  skipped?: SkippedFile[];
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
  skipThumbnails: boolean;
  includeHidden: boolean;
  watch: boolean;
  lastRunAt: number | null;
  lastStatus: 'never' | 'running' | 'success' | 'error' | 'cancelled' | 'paused';
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

interface PreviewResult {
  mode: 'backup' | 'mirror';
  wouldUploadCount: number;
  wouldUploadBytes: number;
  unchangedCount: number;
  wouldDelete: string[];
  wouldDeleteCount: number;
  wouldDeleteTruncated: boolean;
  deletionWouldSkip: string | null;
  message: string;
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
  paused: '--signal-warning',
};
function statusStyle(s: BackupSet['lastStatus']): CSSProperties {
  const v = STATUS_SIGNAL[s];
  if (!v) return { color: 'var(--text-weak)', background: 'rgb(255 255 255 / 0.05)' };
  return { color: `var(${v})`, background: `color-mix(in srgb, var(${v}) 15%, transparent)` };
}

const MODE_LABEL = { add: 'add new', backup: 'backup', mirror: 'mirror' } as const;

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

/** Live preview of the Drive folder name — mirrors the server's sanitizeSegment. */
function sanitizePreview(name: string): string {
  // eslint-disable-next-line no-control-regex
  return (name || '').replace(/[/\\\x00-\x1f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '') || 'set';
}

export default function BackupSets({ refreshKey }: { refreshKey: number }) {
  const { toast } = useToast();
  const { reportAuthError } = useAuth();
  const [sets, setSets] = useState<BackupSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<BackupSet>>({});
  // Ids the user just hit Cancel on — show immediate feedback until the run
  // actually stops (the backend may take a moment to kill the transfer).
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [pausing, setPausing] = useState<Set<string>>(new Set());
  const [verifying, setVerifying] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Record<string, PreviewResult>>({});
  // Which sets have their "skipped files" panel expanded.
  const [openSkips, setOpenSkips] = useState<Record<string, boolean>>({});
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
            else if (n.lastStatus === 'error') {
              toast(`“${n.name}” failed — ${n.lastMessage ?? 'error'}`, 'error');
              reportAuthError(n.lastMessage ?? undefined); // raise the banner if it was a session expiry
            } else if (n.lastStatus === 'cancelled') toast(`“${n.name}” cancelled`, 'info');
            else if (n.lastStatus === 'paused') toast(`“${n.name}” paused`, 'info');
          }
        }
        setSets(next);
        // Drop the cancelling/pausing flags once a set is no longer running.
        const stillRunning = (id: string) => next.find((s) => s.id === id)?.lastStatus === 'running';
        const prune = (prev: Set<string>) => {
          if (prev.size === 0) return prev;
          const still = new Set([...prev].filter(stillRunning));
          return still.size === prev.size ? prev : still;
        };
        setCancelling(prune);
        setPausing(prune);
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
    const cur = sets.find((s) => s.id === id);
    const verb = cur?.lastStatus === 'paused' ? 'Resuming' : 'Running';
    setSets((prev) => prev.map((s) => (s.id === id ? { ...s, lastStatus: 'running' } : s)));
    closePreview(id); // a fresh run makes any open preview stale
    toast(`${verb}${cur?.name ? ` “${cur.name}”` : ''}…`, 'info');
    await fetch(`/api/backup-sets/${id}/run`, { method: 'POST' });
    load();
  };
  const cancel = async (id: string) => {
    setCancelling((prev) => new Set(prev).add(id)); // immediate feedback
    await fetch(`/api/backup-sets/${id}/cancel`, { method: 'POST' });
    load();
  };
  const pause = async (id: string) => {
    setPausing((prev) => new Set(prev).add(id)); // immediate feedback
    await fetch(`/api/backup-sets/${id}/pause`, { method: 'POST' });
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
      const msg = e instanceof Error ? e.message : String(e);
      toast(msg, 'error');
      reportAuthError(msg); // raise the reconnect banner if verify failed on a dead session
    } finally {
      setVerifying((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
      load();
    }
  };
  const closePreview = (id: string) =>
    setPreviews((prev) => {
      if (!prev[id]) return prev;
      const n = { ...prev };
      delete n[id];
      return n;
    });
  const preview = async (id: string) => {
    setPreviewing((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/backup-sets/${id}/dry-run`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Preview failed');
      setPreviews((prev) => ({ ...prev, [id]: d as PreviewResult }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(msg, 'error');
      reportAuthError(msg); // a dead session surfaces here too
    } finally {
      setPreviewing((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
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
    // Send ONLY the fields the edit form actually changes. Never round-trip
    // sourcePaths/targetPath: they're stored as absolute in-container paths and the
    // API would re-resolve them under LOCAL_ROOT (doubling the prefix), and sending
    // them would needlessly reset the upload catalog. The edit form has no source/
    // target pickers, so they can't change here anyway.
    const payload = {
      name: draft.name,
      mode: draft.mode,
      schedule: draft.schedule,
      scheduleHour: draft.scheduleHour,
      scheduleMinute: draft.scheduleMinute,
      scheduleDow: draft.scheduleDow,
      excludes: draft.excludes,
      skipThumbnails: draft.skipThumbnails,
      includeHidden: draft.includeHidden,
      watch: draft.watch,
      // Changing this renames the Drive folder + rewrites catalog keys server-side.
      targetSubfolder: draft.targetSubfolder,
    };
    const res = await fetch(`/api/backup-sets/${editId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast(d.error || 'Failed to save changes', 'error');
      return;
    }
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
                <div className="space-y-1">
                  <label className="block text-[10px] font-medium uppercase tracking-wide text-[color:var(--muted)]">
                    Drive folder
                  </label>
                  <input
                    value={draft.targetSubfolder ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, targetSubfolder: e.target.value }))}
                    placeholder="Drive subfolder"
                    className="w-full pfield px-2 py-1 text-sm"
                  />
                  <p className="truncate text-[11px] text-[color:var(--muted)]">
                    Files go to{' '}
                    <span className="text-[color:var(--accent-2)]">
                      {targetLabel(draft.targetPath ?? s.targetPath)}/{sanitizePreview(draft.targetSubfolder ?? '')}/…
                    </span>
                    {sanitizePreview(draft.targetSubfolder ?? '') !== s.targetSubfolder && (
                      <span className="text-[color:var(--signal-warning)]"> · renames the Drive folder on save</span>
                    )}
                  </p>
                </div>
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
                <label className="flex cursor-pointer items-center gap-2 text-xs text-[color:var(--muted)]">
                  <input
                    type="checkbox"
                    checked={!!draft.skipThumbnails}
                    onChange={(e) => setDraft((d) => ({ ...d, skipThumbnails: e.target.checked }))}
                    className="accent-[color:var(--accent)]"
                  />
                  Skip thumbnails on Drive
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-[color:var(--muted)]">
                  <input
                    type="checkbox"
                    checked={!!draft.includeHidden}
                    onChange={(e) => setDraft((d) => ({ ...d, includeHidden: e.target.checked }))}
                    className="accent-[color:var(--accent)]"
                  />
                  Include hidden files (dotfiles)
                </label>
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
              <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{s.name}</span>
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px]" style={statusStyle(s.lastStatus)}>
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
                    {s.schedule !== 'off' &&
                      s.nextRunAt &&
                      s.lastStatus !== 'running' &&
                      s.lastStatus !== 'paused' && (
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
                          ? `${s.progress.doneFiles}/${s.progress.totalFiles} files · ${formatBytes(s.progress.doneBytes)}/${formatBytes(s.progress.totalBytes)}`
                          : `${s.progress.doneFiles.toLocaleString()} uploaded · ${formatBytes(s.progress.doneBytes)}`}
                        {s.progress.bytesPerSec ? ` · ${formatBytes(s.progress.bytesPerSec)}/s` : ''}
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

                  {/* Skipped-files panel: files the last run couldn't back up (name
                      unsupported / unreadable). Skipping is never fatal — the rest
                      still uploads — so this is informational, tucked behind a toggle.
                      Paths wrap (not truncate) so they're fully readable on any device. */}
                  {(() => {
                    if (s.lastStatus === 'running') return null;
                    const sk = s.recentRuns?.[0]?.skipped ?? [];
                    if (sk.length === 0) return null;
                    const open = !!openSkips[s.id];
                    const more = sk.length >= 100; // the engine caps the sample at 100
                    return (
                      <div className="mt-1.5">
                        <button
                          type="button"
                          onClick={() => setOpenSkips((o) => ({ ...o, [s.id]: !o[s.id] }))}
                          className="inline-flex items-center gap-1 text-[11px] hover:underline"
                          style={{ color: 'var(--signal-warning)' }}
                          aria-expanded={open}
                        >
                          <span aria-hidden>{open ? '▾' : '▸'}</span>
                          {sk.length}
                          {more ? '+' : ''} file{sk.length === 1 ? '' : 's'} skipped
                        </button>
                        {open && (
                          <div className="mt-1 rounded-lg border border-[color:var(--border)] bg-[color:var(--panel-2)]/50 p-2 text-[11px]">
                            <p className="text-[color:var(--muted)]">
                              Skipped — everything else was backed up, and a backup is never paused or stopped for these:
                            </p>
                            <ul className="mt-1.5 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                              {sk.map((f) => (
                                <li key={f.rel} className="min-w-0">
                                  <div className="break-all font-mono text-[color:var(--text)]">{f.rel}</div>
                                  <div className="break-all text-[color:var(--muted)]">{f.reason}</div>
                                </li>
                              ))}
                              {more && (
                                <li className="text-[color:var(--muted)]">… and more (showing the first {sk.length})</li>
                              )}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
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
                        <>
                          <button
                            onClick={() => pause(s.id)}
                            disabled={pausing.has(s.id) || cancelling.has(s.id)}
                            className="pbtn pbtn--ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                            style={{ color: 'var(--signal-warning)' }}
                            title="Pause now and resume later (continues from where it left off)"
                          >
                            {pausing.has(s.id) && (
                              <span className="h-3 w-3 animate-spin rounded-full border-2 border-[color:var(--border)] border-t-[color:var(--signal-warning)]" />
                            )}
                            {pausing.has(s.id) ? 'Pausing…' : 'Pause'}
                          </button>
                          <button
                            onClick={() => cancel(s.id)}
                            disabled={cancelling.has(s.id) || pausing.has(s.id)}
                            className="pbtn pbtn--ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                            style={{ color: 'var(--signal-danger)' }}
                          >
                            {cancelling.has(s.id) && (
                              <span className="h-3 w-3 animate-spin rounded-full border-2 border-[color:var(--border)] border-t-[color:var(--signal-danger)]" />
                            )}
                            {cancelling.has(s.id) ? 'Cancelling…' : 'Cancel'}
                          </button>
                        </>
                      ) : (
                        <button onClick={() => run(s.id)} className="pbtn pbtn--solid px-3 py-1.5 text-xs">
                          {s.lastStatus === 'paused' ? 'Resume' : 'Run'}
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
                          onClick={() => preview(s.id)}
                          disabled={s.lastStatus === 'running' || previewing.has(s.id)}
                          className="pbtn pbtn--ghost px-2.5 py-1.5 text-xs"
                          title="Dry run — show what the next backup would upload, and (mirror) which Drive files it would delete, without changing anything"
                        >
                          {previewing.has(s.id) ? 'Previewing…' : 'Preview'}
                        </button>
                      )}
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
              {previews[s.id] &&
                (() => {
                  const p = previews[s.id];
                  return (
                    <div className="mt-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--panel-2)]/50 p-2.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-[color:var(--text)]">Preview · nothing was changed</span>
                        <button
                          onClick={() => closePreview(s.id)}
                          className="text-[color:var(--muted)] hover:text-[color:var(--text)]"
                          aria-label="Close preview"
                        >
                          ✕
                        </button>
                      </div>
                      <p className="tnum mt-1 text-[color:var(--muted)]">
                        <strong className="text-[color:var(--text)]">{p.wouldUploadCount.toLocaleString()}</strong> to
                        upload ({formatBytes(p.wouldUploadBytes)}) ·{' '}
                        {p.unchangedCount.toLocaleString()} unchanged
                      </p>
                      {p.mode === 'mirror' &&
                        (p.deletionWouldSkip ? (
                          <p className="mt-1" style={{ color: 'var(--signal-warning)' }}>
                            Deletion would be skipped for safety: {p.deletionWouldSkip}
                          </p>
                        ) : p.wouldDeleteCount > 0 ? (
                          <div className="mt-1.5">
                            <p style={{ color: 'var(--signal-danger)' }}>
                              {p.wouldDeleteCount.toLocaleString()} item{p.wouldDeleteCount === 1 ? '' : 's'} on Drive
                              would be deleted (gone locally):
                            </p>
                            <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto pr-1 font-mono text-[11px] text-[color:var(--muted)]">
                              {p.wouldDelete.map((r) => (
                                <li key={r} className="truncate" title={r}>
                                  {r}
                                </li>
                              ))}
                              {p.wouldDeleteTruncated && (
                                <li className="text-[color:var(--muted)]">
                                  … and {(p.wouldDeleteCount - p.wouldDelete.length).toLocaleString()} more
                                </li>
                              )}
                            </ul>
                          </div>
                        ) : (
                          <p className="mt-1 text-[color:var(--muted)]">Nothing on Drive would be deleted.</p>
                        ))}
                    </div>
                  );
                })()}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
