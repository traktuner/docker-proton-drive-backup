import { promises as fs } from 'node:fs';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

/**
 * Browses the local (in-container) filesystem under a configured root.
 * Mount the shares you want to back up under LOCAL_ROOT (default /sources).
 */
export const LOCAL_ROOT = process.env.LOCAL_ROOT || '/sources';

export interface LocalEntry {
  name: string;
  type: 'file' | 'folder';
  size?: number;
  /** Path relative to LOCAL_ROOT, always starting with '/'. */
  path: string;
  absPath: string;
}

/** Resolve a relative path safely inside LOCAL_ROOT (no traversal escape). */
export function resolveLocal(relPath: string): string {
  const clean = path.normalize('/' + (relPath || '')).replace(/^(\.\.(\/|\\|$))+/, '');
  const abs = path.join(/*turbopackIgnore: true*/ LOCAL_ROOT, clean);
  if (abs !== LOCAL_ROOT && !abs.startsWith(LOCAL_ROOT + path.sep)) {
    throw new Error('Path escapes LOCAL_ROOT');
  }
  return abs;
}

/**
 * An absolute source path expressed relative to LOCAL_ROOT, without a leading
 * slash (e.g. /sources/foldera/Fotos → "foldera/Fotos"). This is the structure
 * we mirror on Drive so two same-named folders from different paths never collide.
 */
export function relToLocalRoot(abs: string): string {
  if (abs === LOCAL_ROOT) return '';
  const rel = abs.startsWith(LOCAL_ROOT + path.sep) ? abs.slice(LOCAL_ROOT.length) : abs;
  return rel.replace(/^\/+/, '');
}

export { sanitizeSegment } from '../lib/format';

export interface WalkedFile {
  abs: string;
  /** Path relative to the upload root (the walk's relBase + path inside source). */
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  /** Include hidden dotfiles/dotfolders (default: skip them, as the browser does). */
  includeHidden?: boolean;
  /**
   * Called for an entry the walk had to skip because it could not be READ — a
   * permission/IO error on a file's stat or a folder's readdir. NOT called for
   * intentionally-skipped dotfiles. Lets the engine surface unreadable files as
   * failures instead of losing them silently (and, in mirror mode, this keeps the
   * deletion pass from mistaking an unreadable-but-present file for "gone").
   */
  onSkip?: (rel: string, reason: string) => void;
  /** A symbolic link (not followed: loops, duplicates, targets outside the share). */
  onSymlink?: (rel: string) => void;
  /**
   * Called for every directory the walk enters (rel), including the source root,
   * with the names of its (visible) subdirectories — or null if it is unreadable.
   * The directory's files are yielded after this call and before any subdirectory.
   */
  onDir?: (rel: string, subdirs: string[] | null) => void;
  /** Called for a directory that has no (non-hidden) entries at all. */
  onEmptyDir?: (rel: string) => void;
}

/** The errno code of a filesystem error (EACCES/EPERM/EIO…), for a readable reason. */
function skipReason(e: unknown): string {
  return (e as NodeJS.ErrnoException)?.code || 'unreadable';
}

/**
 * The scanner thread. Synchronous readdir/stat are ~12x cheaper in CPU than the
 * promise-based calls (measured: 8 µs vs 95 µs per file, which made an unchanged
 * run over 1M files cost 157 s of CPU), but they block — so they run in a worker
 * thread, never on the thread that serves the UI. A NAS share that hangs blocks
 * only this worker. Entries travel in batches with one batch in flight
 * (backpressure: the worker waits for "next"), so memory stays bounded no matter
 * how fast the disk is compared to the uploads.
 *
 * Kept as source text (eval worker) so it needs no separate build artefact.
 */
const SCAN_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { root, relBase, includeHidden } = workerData;
const BATCH = 512;
let batch = [];
let wake = null;
parentPort.on('message', () => { const w = wake; wake = null; if (w) w(); });
const flush = async () => {
  if (!batch.length) return;
  const out = batch; batch = [];
  parentPort.postMessage(out);
  await new Promise((r) => (wake = r));
};
const reason = (e) => (e && e.code) || 'unreadable';
// Adaptive stat strategy (see recur): probe the first PROBES stats synchronously.
const PROBES = 64, SLOW_NS = 150000, PARALLEL = 32;
let slow = workerData.forceParallel ? true : null, probes = 0, probeNs = 0;
async function recur(dir, rel) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { batch.push(['d', rel, null], ['s', rel, 'folder not readable (' + reason(e) + ')']); return; }
  const visible = includeHidden ? ents : ents.filter((e) => !e.name.startsWith('.'));
  // A folder is announced with the names of its subfolders; its files follow
  // before any subfolder is entered (the engine diffs one folder at a time).
  batch.push(['d', rel, visible.filter((e) => e.isDirectory()).map((e) => e.name)]);
  if (visible.length === 0) batch.push(['e', rel]);
  const subdirs = [];
  const files = [];
  for (const e of visible) {
    const abs = path.join(dir, e.name);
    const r = rel + '/' + e.name;
    if (e.isDirectory()) subdirs.push([abs, r]);
    else if (e.isFile()) files.push([abs, r]);
    else if (e.isSymbolicLink()) batch.push(['l', r]); // never followed: reported, not lost silently
  }
  // Local disks: synchronous stat (~8 µs). Network mounts (NFS/SMB): each stat is a
  // round trip, so issue many at once. Decided by measuring the first stats.
  for (let i = 0; i < files.length; ) {
    const n = slow ? Math.min(PARALLEL, files.length - i) : 1;
    const chunk = files.slice(i, i + n);
    i += n;
    let results;
    if (n === 1) {
      const t0 = process.hrtime.bigint();
      try { results = [fs.statSync(chunk[0][0])]; } catch (err) { results = [err]; }
      if (slow === null && ++probes <= PROBES) {
        probeNs += Number(process.hrtime.bigint() - t0);
        if (probes === PROBES) slow = probeNs / PROBES > SLOW_NS;
      }
    } else {
      results = await Promise.all(chunk.map(([abs]) => fs.promises.stat(abs).catch((err) => err)));
    }
    for (let k = 0; k < chunk.length; k++) {
      const s = results[k];
      const [abs, r] = chunk[k];
      if (s instanceof Error) batch.push(['s', r, 'not readable (' + reason(s) + ')']);
      else batch.push(['f', r, abs, s.size, s.mtimeMs]);
    }
    if (batch.length >= BATCH) await flush();
  }
  for (const [abs, r] of subdirs) await recur(abs, r);
  if (batch.length >= BATCH) await flush();
}
(async () => { await recur(root, relBase); await flush(); parentPort.postMessage(null); })();
`;

/**
 * Streaming walk of all files under an absolute source path: yields one file at
 * a time instead of building the full array. Each file's `rel` is `relBase` plus
 * its path inside the source, mirroring how it will be laid out on Drive. Hidden
 * dotfiles are skipped unless `opts.includeHidden` is set; unreadable entries are
 * reported via `opts.onSkip` instead of being dropped silently. Directories are
 * reported via onDir (before their content) and onEmptyDir. Memory is bounded by
 * one batch; the filesystem work happens in a worker thread (see SCAN_WORKER).
 * Files of a directory come before its subdirectories.
 */
export async function* walkSourceStream(
  absPath: string,
  relBase: string = path.basename(absPath),
  opts: WalkOptions = {},
): AsyncGenerator<WalkedFile> {
  const { includeHidden = false, onSkip, onDir, onEmptyDir, onSymlink } = opts;
  let st;
  try {
    st = await fs.stat(absPath);
  } catch {
    // The SOURCE ROOT itself is missing/unreadable — handled at a higher level
    // (missing-source mirror gate / runner checks), so stay silent here.
    return;
  }
  if (st.isFile()) {
    yield { abs: absPath, rel: relBase, size: st.size, mtimeMs: st.mtimeMs };
    return;
  }
  if (!st.isDirectory()) return;

  const worker = new Worker(SCAN_WORKER, { eval: true, workerData: { root: absPath, relBase, includeHidden, forceParallel: process.env.PDB_SCAN_FORCE_PARALLEL === '1' } });
  const queue: (unknown[][] | null)[] = [];
  let waiting: (() => void) | null = null;
  let failure: Error | null = null;
  worker.on('message', (m) => {
    queue.push(m);
    waiting?.();
  });
  worker.on('error', (e: Error) => {
    failure = e;
    waiting?.();
  });
  try {
    for (;;) {
      while (queue.length === 0 && !failure) await new Promise<void>((r) => (waiting = r));
      waiting = null;
      if (failure) throw failure;
      const items = queue.shift()!;
      if (items === null) return;
      worker.postMessage(0); // let the worker fill the next batch while we work on this one
      for (const it of items) {
        switch (it[0]) {
          case 'f':
            yield { rel: it[1] as string, abs: it[2] as string, size: it[3] as number, mtimeMs: it[4] as number };
            break;
          case 'd':
            onDir?.(it[1] as string, it[2] as string[] | null);
            break;
          case 'e':
            onEmptyDir?.(it[1] as string);
            break;
          case 's':
            onSkip?.(it[1] as string, it[2] as string);
            break;
          case 'l':
            onSymlink?.(it[1] as string);
            break;
        }
      }
    }
  } finally {
    void worker.terminate(); // also on early exit (cancel) — never leaks a scanner
  }
}

export async function listLocal(relPath: string): Promise<LocalEntry[]> {
  const abs = resolveLocal(relPath);
  let dirents;
  try {
    dirents = await fs.readdir(/*turbopackIgnore: true*/ abs, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      // Root not mounted yet - return empty rather than crashing.
      await fs.mkdir(abs, { recursive: true }).catch(() => {});
      return [];
    }
    throw e;
  }

  const entries = await Promise.all(
    dirents
      .filter((d) => !d.name.startsWith('.'))
      .map(async (d) => {
        const childAbs = path.join(/*turbopackIgnore: true*/ abs, d.name);
        const rel = path.relative(LOCAL_ROOT, childAbs);
        const entry: LocalEntry = {
          name: d.name,
          type: d.isDirectory() ? 'folder' : 'file',
          path: '/' + rel,
          absPath: childAbs,
        };
        if (d.isFile()) {
          try {
            entry.size = (await fs.stat(/*turbopackIgnore: true*/ childAbs)).size;
          } catch {
            /* ignore */
          }
        }
        return entry;
      }),
  );

  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Mount state of a source root: whether it is its own mount (its st_dev differs
 * from its parent directory's) and whether it currently holds any entry. Used by
 * Mirror to tell an offline NAS share — whose mountpoint is still there but is now
 * an empty directory of the parent filesystem — from a folder the user emptied.
 */
export async function sourceMark(abs: string): Promise<{ exists: boolean; mounted: boolean; nonEmpty: boolean }> {
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    return { exists: false, mounted: false, nonEmpty: false };
  }
  let mounted = false;
  try {
    const parent = await fs.stat(path.dirname(abs));
    mounted = parent.dev !== st.dev;
  } catch {
    mounted = false;
  }
  let nonEmpty = st.isFile();
  if (st.isDirectory()) {
    try {
      const dir = await fs.opendir(abs);
      nonEmpty = (await dir.read()) !== null;
      await dir.close();
    } catch {
      nonEmpty = false;
    }
  }
  return { exists: true, mounted, nonEmpty };
}
