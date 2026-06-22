'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth, looksLikeAuthError } from './AuthProvider';

export interface PaneEntry {
  name: string;
  type: 'file' | 'folder';
  size?: number;
  /** Stable id used for navigation + selection (local: rel path, drive: uid). */
  id: string;
}

export type CheckState = 'checked' | 'unchecked' | 'indeterminate';

/** Tri-state selection model for the source pane (lifted to the parent). */
export interface SelectionApi {
  getState: (path: string, isFolder: boolean) => CheckState;
  /** Toggle an entry; siblingPaths are the other entries in the same folder. */
  toggle: (path: string, isFolder: boolean, siblingPaths: string[]) => void;
}

interface FilePaneProps {
  title: string;
  badge: string;
  rootLabel?: string;
  load: (path: string) => Promise<{ entries: PaneEntry[] }>;
  selection?: SelectionApi;
  onPathChange?: (path: string) => void;
  onNewFolder?: (currentPath: string, name: string) => Promise<void>;
  onDelete?: (entryPath: string, entry: PaneEntry) => Promise<void>;
  /** If set, the refresh button first clears the server-side cache (deep resync). */
  onDeepRefresh?: () => Promise<void>;
}

function fmtSize(n?: number): string {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function sortEntries(a: PaneEntry[]): PaneEntry[] {
  return [...a].sort((x, y) =>
    x.type !== y.type ? (x.type === 'folder' ? -1 : 1) : x.name.localeCompare(y.name),
  );
}

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="#e0b341" aria-hidden>
    <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
  </svg>
);
const FileIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" aria-hidden>
    <path d="M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#3b4a6b" stroke="#6f86bd" />
    <path d="M13 2v5h5" fill="#22304d" stroke="#6f86bd" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </svg>
);
const RefreshIcon = ({ spinning }: { spinning?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
  </svg>
);

export default function FilePane({
  title,
  badge,
  rootLabel = 'root',
  load,
  selection,
  onPathChange,
  onNewFolder,
  onDelete,
  onDeepRefresh,
}: FilePaneProps) {
  const { status: authStatus, reconnect } = useAuth();
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<PaneEntry[]>([]);
  const [firstLoad, setFirstLoad] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Track the request in flight so a slow response can't overwrite a newer one.
  const reqId = useRef(0);
  // Client-side cache of visited folders. Navigating back to a visited folder
  // paints instantly from here (no skeleton) while we revalidate in the
  // background - stale-while-revalidate. Cleared/forced on deep refresh.
  const cacheRef = useRef<Map<string, PaneEntry[]>>(new Map());

  const fetchPath = useCallback(
    (p: string, opts: { keep?: boolean; force?: boolean } = {}) => {
      const id = ++reqId.current;
      if (opts.force) cacheRef.current.delete(p);
      const cached = cacheRef.current.get(p);
      if (cached) {
        setEntries(cached); // instant paint; revalidated below
      } else if (!opts.keep) {
        setEntries([]); // uncached navigation → skeleton
      }
      setRefreshing(true);
      setError(null);
      load(p)
        .then((res) => {
          if (id === reqId.current) {
            const sorted = sortEntries(res.entries);
            cacheRef.current.set(p, sorted);
            setEntries(sorted);
          }
        })
        .catch((e) => {
          if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (id === reqId.current) {
            setRefreshing(false);
            setFirstLoad(false);
          }
        });
    },
    [load],
  );

  // Navigate (clears + skeleton) whenever the path changes.
  useEffect(() => {
    fetchPath(path);
    onPathChange?.(path);
  }, [path, fetchPath, onPathChange]);

  // Recover the pane on its own once the session is (still/again) authenticated but
  // the pane is showing an auth-looking error — covers genuine recovery AND a false
  // alarm where the forced re-probe confirmed the session was fine all along (so
  // authStatus never transitions). One-shot per distinct error string so a truly
  // persistent auth error can't spin the fetch.
  const authRetryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!error) {
      authRetryRef.current = null; // healthy again — arm for the next error
      return;
    }
    if (authStatus === 'authenticated' && looksLikeAuthError(error) && authRetryRef.current !== error) {
      authRetryRef.current = error;
      fetchPath(path, { force: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, error]);

  const segments = path === '/' ? [] : path.replace(/^\//, '').split('/');
  const navigate = (p: string) => {
    setPendingDelete(null);
    setPath(p);
  };
  const childPath = (name: string) => (path === '/' ? `/${name}` : `${path}/${name}`);
  const breadcrumbTo = (i: number) => navigate(i < 0 ? '/' : '/' + segments.slice(0, i + 1).join('/'));

  const siblingPaths = () => entries.map((e) => e.id);

  const submitNewFolder = async () => {
    if (!onNewFolder || !newName.trim() || folderBusy) return;
    const folderName = newName.trim();
    setFolderBusy(true);
    setFolderError(null);
    try {
      await onNewFolder(path, folderName);
      // Optimistic: show the folder immediately (avoids the CLI cache lag).
      setEntries((prev) =>
        prev.some((e) => e.name === folderName && e.type === 'folder')
          ? prev
          : sortEntries([...prev, { name: folderName, type: 'folder', id: `tmp:${folderName}` }]),
      );
      cacheRef.current.delete(path); // stale now - refetch fresh on next visit
      setNewName('');
      setCreating(false);
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e));
    } finally {
      setFolderBusy(false);
    }
  };

  const confirmDelete = async (entry: PaneEntry) => {
    if (!onDelete) return;
    setDeleteBusy(true);
    const snapshot = entries;
    // Optimistic removal - keeps the list responsive, dodges the cache lag.
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    cacheRef.current.delete(path); // stale now - refetch fresh on next visit
    setPendingDelete(null);
    try {
      await onDelete(childPath(entry.name), entry);
    } catch (e) {
      setEntries(snapshot); // restore on failure
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  const showSkeleton = firstLoad || (refreshing && entries.length === 0);

  return (
    <div className="flex h-[65vh] min-h-0 flex-col rounded-xl border border-[color:var(--border)] lg:h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-[color:var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          <span className="rounded-md bg-[color:var(--panel-2)] px-2 py-0.5 text-[11px] text-[color:var(--muted)]">
            {badge}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={async () => {
              if (onDeepRefresh) {
                setRefreshing(true);
                await onDeepRefresh().catch(() => {});
              }
              cacheRef.current.clear(); // explicit refresh → drop all cached folders
              fetchPath(path, { force: true });
            }}
            title={onDeepRefresh ? 'Refresh (resync from Drive)' : 'Refresh'}
            disabled={refreshing}
            className="pbtn pbtn--ghost p-2 text-[color:var(--muted)] hover:text-[color:var(--text)]"
          >
            <RefreshIcon spinning={refreshing} />
          </button>
          {onNewFolder && (
            <button onClick={() => setCreating((v) => !v)} className="pbtn pbtn--ghost px-2.5 py-1.5 text-xs">
              + Folder
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 border-b border-[color:var(--border)] px-4 py-2 text-xs text-[color:var(--muted)]">
        <button onClick={() => breadcrumbTo(-1)} className="hover:text-[color:var(--text)]">
          {rootLabel}
        </button>
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <span>/</span>
            <button onClick={() => breadcrumbTo(i)} className="hover:text-[color:var(--text)]">
              {seg}
            </button>
          </span>
        ))}
      </div>

      {creating && (
        <div className="border-b border-[color:var(--border)] px-4 py-2">
          <div className="flex gap-2">
            <input
              autoFocus
              value={newName}
              disabled={folderBusy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitNewFolder()}
              placeholder="New folder name"
              className="flex-1 pfield px-2 py-1 text-sm disabled:opacity-60"
            />
            <button
              onClick={submitNewFolder}
              disabled={folderBusy || !newName.trim()}
              className="pbtn pbtn--solid px-3 py-1.5 text-sm"
            >
              {folderBusy ? 'Creating…' : 'Create'}
            </button>
          </div>
          {folderError && (
            <p className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-300">
              {folderError}
            </p>
          )}
        </div>
      )}

      {/* List */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error &&
          (authStatus !== 'authenticated' && looksLikeAuthError(error) ? (
            // Defer to the global session banner — show a calm reconnect prompt here
            // instead of the raw "no session" CLI text.
            <div className="m-3 rounded-md border border-[color:var(--border)] bg-[color:var(--panel-2)] p-3 text-sm text-[color:var(--muted)]">
              Disconnected from Proton Drive.{' '}
              <button onClick={reconnect} className="underline hover:no-underline" style={{ color: 'var(--accent-2)' }}>
                Reconnect
              </button>{' '}
              to view your files.
            </div>
          ) : (
            <div className="m-3 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
              {error}
            </div>
          ))}
        {showSkeleton ? (
          <ul className="animate-pulse space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="h-5 w-5 rounded bg-[color:var(--panel-2)]" />
                <span className="h-3 flex-1 rounded bg-[color:var(--panel-2)]" style={{ maxWidth: `${70 - i * 7}%` }} />
              </li>
            ))}
          </ul>
        ) : entries.length === 0 && !error ? (
          <div className="p-4 text-sm text-[color:var(--muted)]">This folder is empty.</div>
        ) : (
          <ul className="divide-y divide-[color:var(--border)]/60">
            {entries.map((entry) => {
              const state = selection ? selection.getState(entry.id, entry.type === 'folder') : 'unchecked';
              const sel = state === 'checked' || state === 'indeterminate';
              const isPending = pendingDelete === entry.id;
              return (
                <li
                  key={entry.id}
                  className={`group flex items-center gap-3 px-4 py-2 text-sm hover:bg-[color:var(--panel-2)] ${
                    sel ? 'bg-[color:var(--accent)]/10' : ''
                  }`}
                >
                  {selection && (
                    <input
                      type="checkbox"
                      ref={(el) => {
                        if (el) el.indeterminate = state === 'indeterminate';
                      }}
                      checked={state === 'checked'}
                      onChange={() => selection.toggle(entry.id, entry.type === 'folder', siblingPaths())}
                      className="h-4 w-4 accent-[color:var(--accent)]"
                    />
                  )}
                  <button
                    onClick={() =>
                      entry.type === 'folder'
                        ? navigate(childPath(entry.name))
                        : selection?.toggle(entry.id, false, siblingPaths())
                    }
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    {entry.type === 'folder' ? <FolderIcon /> : <FileIcon />}
                    <span className="truncate">{entry.name}</span>
                  </button>

                  {isPending ? (
                    <span className="flex items-center gap-2 text-xs">
                      <span className="text-[color:var(--muted)]">Delete?</span>
                      <button
                        onClick={() => confirmDelete(entry)}
                        disabled={deleteBusy}
                        className="pbtn rounded px-2 py-0.5 text-white"
                        style={{ background: 'var(--signal-danger)' }}
                      >
                        Yes
                      </button>
                      <button onClick={() => setPendingDelete(null)} className="pbtn pbtn--ghost px-2 py-0.5">
                        No
                      </button>
                    </span>
                  ) : (
                    <>
                      <span className="shrink-0 text-xs text-[color:var(--muted)]">
                        {entry.type === 'file' ? fmtSize(entry.size) : ''}
                      </span>
                      {onDelete && (
                        <button
                          onClick={() => setPendingDelete(entry.id)}
                          title="Move to trash"
                          className="shrink-0 text-[color:var(--muted)] opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                        >
                          <TrashIcon />
                        </button>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

    </div>
  );
}
