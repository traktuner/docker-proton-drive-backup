'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import FilePane, { type PaneEntry, type SelectionApi } from '@/components/FilePane';
import BackupSets from '@/components/BackupSets';
import Footer from '@/components/Footer';
import StorageBar from '@/components/StorageBar';
import Settings from '@/components/Settings';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/components/AuthProvider';
import { formatBytes } from '@/lib/format';
import { DOW, DOW_ORDER } from '@/lib/schedule';

type Mode = 'add' | 'backup' | 'mirror';
type Schedule = 'off' | 'hourly' | 'daily' | 'weekly';

const MODE_INFO: Record<Mode, { label: string; desc: string }> = {
  add: {
    label: 'Add new',
    desc: 'Uploads only files that don’t exist on Drive yet. Never updates or deletes. Lightest - good for write-once archives.',
  },
  backup: {
    label: 'Backup',
    desc: 'Uploads new files and re-uploads only the ones that changed (by size, date, then checksum). Nothing is downloaded, unchanged files are skipped. Deleted-locally files stay on Drive. Recommended.',
  },
  mirror: {
    label: 'Mirror',
    desc: '⚠ Makes Drive match your source exactly: uploads new/changed files AND deletes files on Drive that you removed locally (only within the folders you back up).',
  },
};


interface Estimate {
  bytes: number;
  files: number;
  folders: number;
  counting: boolean;
}

/**
 * Convert unticked descendants into engine exclude globs. The engine matches
 * excludes against each file's path relative to LOCAL_ROOT (the "<set-folder>/"
 * prefix is stripped before matching), so the globs are simply that LOCAL_ROOT-
 * relative path — e.g. an unticked "/a/b/Fotos/private" → "a/b/Fotos/private".
 */
function derivedExcludes(roots: string[], excluded: string[]): string[] {
  const out: string[] = [];
  for (const e of excluded) {
    const underRoot = roots.some((x) => e === x || e.startsWith(`${x}/`));
    if (!underRoot) continue;
    const rel = e.replace(/^\/+/, '');
    out.push(rel, `${rel}/**`); // match the item itself and everything under it
  }
  return out;
}

export default function FilesPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { status: authStatus, reconnect, reportAuthError } = useAuth();
  const [ready, setReady] = useState(false);

  // Tri-state source selection: ticked roots, minus unticked descendants.
  const [roots, setRoots] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const sources = useMemo(() => [...roots], [roots]);
  const selectedSourceExcludes = useMemo(
    () => derivedExcludes([...roots], [...excluded]),
    [roots, excluded],
  );
  // Excluded (unticked) descendants that actually fall under a ticked root and
  // aren't themselves nested under another exclusion - these get subtracted from
  // the size estimate so it reflects what will really be backed up.
  const excludedPaths = useMemo(() => {
    const all = [...excluded].filter((e) => sources.some((r) => e === r || e.startsWith(`${r}/`)));
    return all.filter((e) => !all.some((o) => o !== e && e.startsWith(`${o}/`)));
  }, [excluded, sources]);
  const excludedKey = useMemo(() => [...excludedPaths].sort().join('|'), [excludedPaths]);
  const sourcesKey = useMemo(() => [...sources].sort().join('|'), [sources]);
  const [targetPath, setTargetPath] = useState('/');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<Mode>('backup');
  const [schedule, setSchedule] = useState<Schedule>('off');
  const [hour, setHour] = useState(3);
  const [minute, setMinute] = useState(0);
  const [dow, setDow] = useState(1);
  const [excludes, setExcludes] = useState('');
  const [subfolder, setSubfolder] = useState(''); // optional Drive folder override (else derived from name)
  const [skipThumbnails, setSkipThumbnails] = useState(false);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [localRoot, setLocalRoot] = useState('/sources');
  const [estimate, setEstimate] = useState<Estimate>({ bytes: 0, files: 0, folders: 0, counting: false });

  useEffect(() => {
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d) => (d.authenticated ? setReady(true) : router.replace('/onboarding')))
      .catch(() => router.replace('/onboarding'));
  }, [router]);

  const loadLocal = useCallback(async (path: string) => {
    const d = await fetch(`/api/local/list?path=${encodeURIComponent(path)}`).then((r) => r.json());
    if (d.error) throw new Error(d.error);
    if (typeof d.root === 'string' && d.root) setLocalRoot(d.root);
    const entries: PaneEntry[] = (d.entries ?? []).map((e: any) => ({
      name: e.name,
      type: e.type,
      size: e.size,
      id: e.path,
    }));
    return { entries };
  }, []);

  const consumeSelectedSources = useCallback((consumed: string[]) => {
    const covers = (root: string, value: string) => root === '/' || value === root || value.startsWith(`${root}/`);
    setRoots((prev) => new Set([...prev].filter((value) => !consumed.includes(value))));
    setExcluded((prev) => new Set([...prev].filter((value) => !consumed.some((root) => covers(root, value)))));
  }, []);

  const loadDrive = useCallback(
    async (path: string) => {
      const d = await fetch(`/api/drive/list?path=${encodeURIComponent(path)}`).then((r) => r.json());
      if (d.error) {
        // The Drive pane is the surface that first reveals a dead session; let the
        // shared auth state verify and raise the reconnect banner immediately.
        reportAuthError(d.error);
        throw new Error(d.error);
      }
      const entries: PaneEntry[] = (d.entries ?? []).map((e: any) => ({
        name: e.name,
        type: e.type,
        size: e.size,
        id: e.uid,
      }));
      return { entries };
    },
    [reportAuthError],
  );

  const newDriveFolder = useCallback(async (currentPath: string, folderName: string) => {
    const res = await fetch('/api/drive/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath: currentPath, name: folderName }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to create folder');
  }, []);

  const deleteDrive = useCallback(async (entryPath: string) => {
    const res = await fetch('/api/drive/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entryPath }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to move to trash');
  }, []);

  const deepRefreshDrive = useCallback(async () => {
    await fetch('/api/drive/refresh-cache', { method: 'POST' }).catch(() => {});
  }, []);

  // Tri-state selection model: tick a folder to include everything under it,
  // untick descendants to exclude them (parent then shows an indeterminate dash).
  const selection = useMemo<SelectionApi>(() => {
    const arr = (s: Set<string>) => [...s];
    const rootOf = (p: string) => arr(roots).find((r) => p === r || p.startsWith(`${r}/`));
    const exAncestor = (p: string) => arr(excluded).find((e) => p === e || p.startsWith(`${e}/`));
    const hasExDesc = (p: string) => arr(excluded).some((e) => e.startsWith(`${p}/`));
    // True if some ticked root lives strictly below p — i.e. p is an ancestor of a
    // selection made deeper in the tree (e.g. a file ticked in a sub-subfolder of
    // an otherwise-unticked folder). Such ancestors must read as indeterminate all
    // the way up to the visible root, not as empty.
    const hasRootDesc = (p: string) => arr(roots).some((r) => r.startsWith(`${p}/`));
    const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

    return {
      getState: (p, isFolder) => {
        if (!rootOf(p)) return isFolder && hasRootDesc(p) ? 'indeterminate' : 'unchecked';
        if (exAncestor(p)) return 'unchecked';
        if (isFolder && hasExDesc(p)) return 'indeterminate';
        return 'checked';
      },
      toggle: (p, _isFolder, siblings) => {
        const r = rootOf(p);
        if (!r) {
          // Not under a root → make it a new root (drop nested roots/excludes).
          setRoots((prev) => {
            const n = new Set(prev);
            for (const x of n) if (x === p || x.startsWith(`${p}/`)) n.delete(x);
            n.add(p);
            return n;
          });
          setExcluded((prev) => {
            const n = new Set(prev);
            for (const e of n) if (e === p || e.startsWith(`${p}/`)) n.delete(e);
            return n;
          });
          return;
        }
        const ex = exAncestor(p);
        if (ex) {
          // Re-include an excluded item.
          setExcluded((prev) => {
            const n = new Set(prev);
            if (ex === p) {
              n.delete(p);
            } else if (ex === parentOf(p)) {
              // Open the excluded parent, keep its other children excluded.
              n.delete(ex);
              for (const s of siblings) if (s !== p) n.add(s);
            } else {
              n.delete(ex); // deeper case: just re-include the excluded ancestor
            }
            return n;
          });
          return;
        }
        // Currently included.
        if (p === r) {
          setRoots((prev) => {
            const n = new Set(prev);
            n.delete(p);
            return n;
          });
          setExcluded((prev) => {
            const n = new Set(prev);
            for (const e of n) if (e === p || e.startsWith(`${p}/`)) n.delete(e);
            return n;
          });
        } else {
          setExcluded((prev) => {
            const n = new Set(prev);
            for (const e of n) if (e.startsWith(`${p}/`)) n.delete(e);
            n.add(p);
            return n;
          });
        }
      },
    };
  }, [roots, excluded]);

  // Live size/count estimate. Each selected path (ticked root = +1, unticked
  // descendant = −1) is counted independently and concurrently:
  //  - countCache: completed counts, reused forever (re-tick = instant).
  //  - liveCounts: partial totals of walks still streaming.
  //  - esMap:      the open EventSource per path.
  // Reconciling on selection change only starts/stops the paths that actually
  // changed - a running walk is never torn down and restarted, so excluding a
  // subfolder while a root is still counting no longer resets the whole count.
  type Count = { bytes: number; files: number; folders: number };
  const countCache = useRef<Map<string, Count>>(new Map());
  const liveCounts = useRef<Map<string, Count>>(new Map());
  const esMap = useRef<Map<string, EventSource>>(new Map());
  const jobsRef = useRef<Map<string, number>>(new Map());

  const recompute = useCallback(() => {
    let bytes = 0;
    let files = 0;
    let folders = 0;
    let counting = false;
    for (const [p, sign] of jobsRef.current) {
      const c = countCache.current.get(p) ?? liveCounts.current.get(p);
      if (c) {
        bytes += sign * c.bytes;
        files += sign * c.files;
        folders += sign * c.folders;
      }
      if (!countCache.current.has(p) && esMap.current.has(p)) counting = true;
    }
    setEstimate({
      bytes: Math.max(0, bytes),
      files: Math.max(0, files),
      folders: Math.max(0, folders),
      counting,
    });
  }, []);

  useEffect(() => {
    const desired = new Map<string, number>();
    for (const p of sources) desired.set(p, 1);
    for (const p of excludedPaths) desired.set(p, -1);
    jobsRef.current = desired;

    // Stop counting paths that are no longer selected.
    for (const [p, es] of esMap.current) {
      if (!desired.has(p)) {
        es.close();
        esMap.current.delete(p);
        liveCounts.current.delete(p);
      }
    }

    // Start a stream for each newly-needed path, leaving in-flight ones alone.
    for (const p of desired.keys()) {
      if (countCache.current.has(p) || esMap.current.has(p)) continue;
      liveCounts.current.set(p, { bytes: 0, files: 0, folders: 0 });
      const es = new EventSource(`/api/local/size?path=${encodeURIComponent(p)}`);
      esMap.current.set(p, es);
      es.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        liveCounts.current.set(p, { bytes: d.bytes, files: d.files, folders: d.folders });
        if (d.done) {
          countCache.current.set(p, { bytes: d.bytes, files: d.files, folders: d.folders });
          liveCounts.current.delete(p);
          es.close();
          esMap.current.delete(p);
        }
        recompute();
      };
      es.onerror = () => {
        es.close();
        esMap.current.delete(p);
        liveCounts.current.delete(p);
        recompute();
      };
    }

    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesKey, excludedKey, recompute]);

  // Close any open size streams when the page unmounts.
  useEffect(
    () => () => {
      for (const es of esMap.current.values()) es.close();
      esMap.current.clear();
    },
    [],
  );

  const handleDrivePath = useCallback((p: string) => setTargetPath(p), []);

  const importConfig = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    toast('Importing config…', 'info');
    try {
      const text = await file.text();
      const res = await fetch('/api/config', { method: 'POST', body: text });
      const d = await res.json();
      const parts = [`${d.imported} added`, `${d.updated} updated`];
      if (d.errors?.length) parts.push(`${d.errors.length} error(s)`);
      toast(parts.join(', ') + (d.errors?.length ? `: ${d.errors[0]}` : ''), d.errors?.length ? 'error' : 'success');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const createSet = async () => {
    if (!name.trim()) return toast('Give the backup set a name', 'error');
    if (sources.length === 0) return toast('Select at least one folder on the left', 'error');
    setCreating(true);
    try {
      const manual = excludes.split('\n').map((s) => s.trim()).filter(Boolean);
      const allExcludes = [...manual, ...derivedExcludes([...roots], [...excluded])];
      const res = await fetch('/api/backup-sets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          sourcePaths: sources,
          targetPath,
          mode,
          schedule,
          scheduleHour: hour,
          scheduleMinute: minute,
          scheduleDow: dow,
          excludes: allExcludes,
          skipThumbnails,
          includeHidden,
          // Optional Drive folder override; the server sanitises + de-dupes per target.
          targetFolder: subfolder.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to create backup set');
      toast(`Backup set “${name.trim()}” created`, 'success');
      setName('');
      setSubfolder('');
      setRoots(new Set());
      setExcluded(new Set());
      setSkipThumbnails(false);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setCreating(false);
    }
  };

  const targetLabel = targetPath === '/' ? 'Drive (root)' : `Drive${targetPath}`;
  // Preview of the set's top-level Drive folder (mirrors server sanitizeSegment).
  // An explicit subfolder override wins; otherwise it's derived from the set name.
  // eslint-disable-next-line no-control-regex
  const previewFolder = (subfolder.trim() || name).replace(/[/\\\x00-\x1f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '') || 'set';

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="flex items-center justify-between gap-3 border-b border-[color:var(--border)] px-5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'var(--accent)' }}
          >
            {/* Tabler "cloud-upload" (MIT) - a clean, recognisable cloud + up arrow. */}
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              className="h-[18px] w-[18px]"
              fill="none"
              stroke="#fff"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7h-1" />
              <path d="M9 15l3 -3l3 3" />
              <path d="M12 12l0 9" />
            </svg>
          </span>
          <span className="truncate font-semibold tracking-tight">Proton Drive Backup</span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <StorageBar />
          {authStatus === 'expired' ? (
            <button
              onClick={reconnect}
              className="flex items-center gap-1.5 text-[color:var(--signal-danger)] hover:underline"
              title="Proton session expired — click to reconnect"
            >
              <span className="h-2 w-2 rounded-full" style={{ background: 'var(--signal-danger)' }} />
              <span className="hidden sm:inline">Reconnect</span>
            </button>
          ) : authStatus === 'reconnecting' ? (
            <span className="flex items-center gap-1.5 text-[color:var(--muted)]" title="Reconnecting…">
              <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: 'var(--signal-warning)' }} />
              <span className="hidden sm:inline">Reconnecting…</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[color:var(--muted)]" title="Connected">
              <span className="h-2 w-2 rounded-full" style={{ background: 'var(--signal-success)' }} />
              <span className="hidden sm:inline">Connected</span>
            </span>
          )}
          <Settings />
        </div>
      </header>

      {!ready ? (
        <div className="flex flex-1 items-center justify-center text-[color:var(--muted)]">
          <span className="animate-pulse">Connecting…</span>
        </div>
      ) : (
        <>
      {/* Dual panes - stacked & tall on mobile, side-by-side filling height on desktop.
          lg:grid-rows-[minmax(0,1fr)] gives the single row a definite height so each
          pane's lg:h-full resolves (without it the panes collapse to 0 at >=lg until a
          resize forces reflow - GitHub #15). */}
      <div className="grid grid-cols-1 gap-4 p-4 lg:min-h-0 lg:flex-1 lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)]">
        <FilePane
          title="Local files"
          badge="Source"
          rootLabel="sources"
          load={loadLocal}
          selection={selection}
        />
        <FilePane
          title="Proton Drive"
          badge="Target"
          rootLabel="Drive"
          load={loadDrive}
          onPathChange={handleDrivePath}
          onNewFolder={newDriveFolder}
          onDelete={deleteDrive}
          onDeepRefresh={deepRefreshDrive}
        />
      </div>

      {/* Builder + sets */}
      <div className="grid grid-cols-1 gap-4 border-t border-[color:var(--border)] p-4 lg:grid-cols-2">
        <div className="rounded-xl border border-[color:var(--border)] p-4">
          <h2 className="mb-4 text-sm font-semibold">New backup set</h2>
          <div className="space-y-5">
            {/* Summary — what this set will do (the headline of the form) */}
            <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--panel-2)]/40 p-3">
              {sources.length === 0 ? (
                <p className="text-xs leading-relaxed text-[color:var(--muted)]">
                  Tick folders in <span className="text-[color:var(--text)]">Local files</span> on the left,
                  then pick a target by navigating{' '}
                  <span className="text-[color:var(--text)]">Proton Drive</span> on the right.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium">
                      {sources.length} source{sources.length === 1 ? '' : 's'}
                    </span>
                    <span className="text-[color:var(--muted)]">→</span>
                    <span className="font-medium text-[color:var(--accent-2)]">{targetLabel}</span>
                  </div>
                  <div className="tnum mt-1.5 flex items-center gap-2 text-xs text-[color:var(--muted)]">
                    {estimate.counting && (
                      <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[color:var(--border)] border-t-[color:var(--accent)]" />
                    )}
                    <span>
                      <strong className="text-[color:var(--text)]">{formatBytes(estimate.bytes)}</strong>
                      {' · '}
                      {estimate.files.toLocaleString()} file{estimate.files === 1 ? '' : 's'}
                      {' · '}
                      {estimate.folders.toLocaleString()} folder{estimate.folders === 1 ? '' : 's'}
                      {excluded.size > 0 ? ` · ${excluded.size} excluded` : ''}
                      {estimate.counting ? ' · counting…' : ''}
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Name */}
            <div className="space-y-1.5">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-[color:var(--muted)]">
                Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Photos to Drive"
                className="w-full pfield px-3 py-2 text-sm"
              />
              <input
                value={subfolder}
                onChange={(e) => setSubfolder(e.target.value)}
                placeholder="Drive folder (optional — defaults to the set name)"
                className="w-full pfield px-3 py-2 text-sm"
              />
              {(name.trim() || subfolder.trim()) && (
                <p className="truncate text-[11px] text-[color:var(--muted)]">
                  Saved to{' '}
                  <span className="text-[color:var(--accent-2)]">
                    {targetLabel}/{previewFolder}/…
                  </span>{' '}
                  — each source keeps its folder path, so same-named folders never collide.
                </p>
              )}
            </div>

            {/* Mode */}
            <div className="space-y-2">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-[color:var(--muted)]">
                Mode
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['add', 'backup', 'mirror'] as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`rounded-lg border px-3 py-2 text-center text-xs font-medium transition ${
                      mode === m
                        ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--text)]'
                        : 'border-[color:var(--border)] text-[color:var(--muted)] hover:bg-[color:var(--panel-2)]'
                    } ${m === 'mirror' && mode === m ? '!border-amber-500/60 !bg-amber-500/10' : ''}`}
                  >
                    {MODE_INFO[m].label}
                  </button>
                ))}
              </div>
              {/* Reserve the tallest description's height so switching modes
                  doesn't make the panel jump bigger/smaller. */}
              <p className="min-h-[3.75rem] text-xs leading-relaxed text-[color:var(--muted)]">
                {MODE_INFO[mode].desc}
              </p>
            </div>

            {/* Schedule */}
            <div className="space-y-2">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-[color:var(--muted)]">
                Schedule
              </label>
              <div className="flex flex-wrap items-center gap-2">
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value as Schedule)}
                className="pfield px-2 py-1 text-sm"
              >
                <option value="off">Manual only</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
              {schedule === 'weekly' && (
                <select
                  value={dow}
                  onChange={(e) => setDow(parseInt(e.target.value, 10))}
                  className="pfield px-2 py-1 text-sm"
                >
                  {DOW_ORDER.map((i) => (
                    <option key={i} value={i}>
                      {DOW[i]}
                    </option>
                  ))}
                </select>
              )}
              {schedule === 'hourly' && (
                <span className="flex items-center gap-1 text-sm">
                  <span className="text-[color:var(--muted)]">at :</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(e) => setMinute(Math.min(59, Math.max(0, +e.target.value)))}
                    className="w-14 pfield px-2 py-1"
                  />
                  <span className="text-xs text-[color:var(--muted)]">past the hour</span>
                </span>
              )}
              {(schedule === 'daily' || schedule === 'weekly') && (
                <span className="flex items-center gap-1 text-sm">
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(e) => setHour(Math.min(23, Math.max(0, +e.target.value)))}
                    className="w-14 pfield px-2 py-1"
                  />
                  <span className="text-[color:var(--muted)]">:</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={minute}
                    onChange={(e) => setMinute(Math.min(59, Math.max(0, +e.target.value)))}
                    className="w-14 pfield px-2 py-1"
                  />
                  <span className="text-xs text-[color:var(--muted)]">server time</span>
                </span>
              )}
              </div>
            </div>

            {/* Advanced — exclude patterns, tucked behind a disclosure (most users
                never need globs). Constant min-height so switching modes doesn't jump. */}
            <div className="min-h-[1.5rem]">
              {mode === 'add' ? (
                <p className="pl-[18px] text-[11px] text-[color:var(--muted)]">
                  Add mode uploads only new files — nothing to exclude.
                </p>
              ) : (
                <details className="group">
                  <summary className="inline-flex cursor-pointer list-none select-none items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--muted)] hover:text-[color:var(--text)] [&::-webkit-details-marker]:hidden">
                    <svg
                      viewBox="0 0 24 24"
                      width="12"
                      height="12"
                      className="transition-transform group-open:rotate-90"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                    Advanced — exclude patterns
                  </summary>
                  <textarea
                    value={excludes}
                    onChange={(e) => setExcludes(e.target.value)}
                    rows={2}
                    placeholder="Glob patterns, one per line (optional) — e.g. *.tmp or node_modules. Or untick items on the left."
                    className="mt-2 w-full resize-y pfield px-3 py-2 text-xs"
                  />
                </details>
              )}
            </div>
            <label className="flex cursor-pointer items-center gap-2 pl-[2px] text-xs text-[color:var(--muted)]">
              <input
                type="checkbox"
                checked={skipThumbnails}
                onChange={(e) => setSkipThumbnails(e.target.checked)}
                className="accent-[color:var(--accent)]"
              />
              Skip thumbnails on Drive (faster uploads, no previews)
            </label>
            <label className="flex cursor-pointer items-center gap-2 pl-[2px] text-xs text-[color:var(--muted)]">
              <input
                type="checkbox"
                checked={includeHidden}
                onChange={(e) => setIncludeHidden(e.target.checked)}
                className="accent-[color:var(--accent)]"
              />
              Include hidden files (dotfiles like .env, .config)
            </label>
            <button onClick={createSet} disabled={creating} className="pbtn pbtn--solid w-full px-4 py-2.5 text-sm">
              {creating ? 'Creating…' : 'Create backup set'}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-[color:var(--border)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Backup sets</h2>
            <div className="flex items-center gap-1.5">
              <a href="/api/config" download className="pbtn pbtn--ghost px-2.5 py-1.5 text-xs">
                Export
              </a>
              <label className="pbtn pbtn--ghost cursor-pointer px-2.5 py-1.5 text-xs">
                Import
                <input
                  type="file"
                  accept=".yaml,.yml,text/yaml"
                  className="hidden"
                  onChange={importConfig}
                />
              </label>
            </div>
          </div>
          <div className="max-h-[38rem] overflow-auto pr-1">
            <BackupSets
              refreshKey={refreshKey}
              selectedSources={sources}
              selectedSourceExcludes={selectedSourceExcludes}
              localRoot={localRoot}
              onSourcesAdded={consumeSelectedSources}
            />
          </div>
        </div>
      </div>
        </>
      )}

      <Footer />
    </div>
  );
}
