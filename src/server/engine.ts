import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { walkSourceStream, relToLocalRoot, sourceMark } from './local';
import { catalog, diffFile, type CatalogEntry, type CatalogFile } from './catalog';
import { backupSets, getDb, type SourceMark } from './db';
import { getUploadConfig } from './upload-config';
import { getMirrorSafetyConfig } from './mirror-safety';
import { mediaTypeFor } from './mime';
import { makeThrottle } from './traffic';
import { DriveError, driveErrorCode, type DriveService, type RemoteNode } from './proton/types';

/**
 * Backup engine on the Proton Drive SDK.
 *
 * One pass over the local tree, diffed against the per-set catalog (catalog.ts).
 * Unchanged files cost a stat and an indexed SQLite lookup — no Drive request and
 * no file read. Changed and new files are read ONCE: the same read feeds the
 * encryption, the SHA-1 Drive stores as the revision digest and the speed limit.
 *
 * Modes
 *  - add:    upload files that are not on Drive yet; never updates or deletes.
 *  - backup: upload new files and a NEW REVISION of every changed file (the
 *            previous version stays restorable in Drive); never deletes.
 *  - mirror: backup + move Drive items of locally removed files to the Drive trash.
 *
 * Correctness rules (each has a regression test in engine.test.ts):
 *  1. The catalog only records what Drive confirmed (after `completion()`).
 *  2. Before uploading a revision, the remote node is checked: if Drive already
 *     holds exactly the local content (e.g. the container died after Drive
 *     confirmed the revision but before the SQLite commit) it is adopted — no
 *     second revision. The same applies when a "new" file's name already exists.
 *  3. "Not found" is only ever concluded from Drive's explicit answer; network,
 *     auth, rate-limit and decryption errors abort or retry, never delete or skip.
 *  4. Deletions (mirror) run only if every source is present AND looks like it did
 *     on the last run (an offline NAS share leaves an EMPTY mountpoint behind),
 *     no upload failed, and the share of removed items is within the safety limit.
 *     Each item is re-read from Drive and must still be our node at the expected
 *     place; a folder that contains anything we did not upload is never trashed
 *     as a whole.
 *  5. Dry run uses the very same scan, decisions and deletion planner — only the
 *     final write/trash calls are skipped.
 */

export interface SkippedFile {
  rel: string;
  reason: string;
}

export interface DeltaResult {
  ok: boolean;
  cancelled: boolean;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  /** Files Drive already had with identical content; recorded without uploading. */
  adoptedCount: number;
  deletedCount: number;
  failedCount: number;
  failedFiles: SkippedFile[];
  uploadedBytes: number;
  /** Why the deletion pass did not run (mirror), if it was skipped. */
  deletionSkipped: string | null;
  message: string;
}

export interface EngineProgress {
  doneFiles: number;
  totalFiles: number;
  doneBytes: number;
  totalBytes: number;
  current: string;
  bytesPerSec?: number;
}

export type Mode = 'add' | 'backup' | 'mirror';

export interface RunSpec {
  setId: string;
  sourcePaths: string[];
  /** Proton path of the target folder ("/my-files/…"). */
  targetPath: string;
  subfolder: string;
  mode: Mode;
  excludes?: string[];
  skipThumbnails?: boolean;
  includeHidden?: boolean;
  /** One-shot: the user confirmed that a now-empty source really was emptied. */
  allowEmptySource?: boolean;
}

export interface RunHooks {
  log?: (msg: string) => void;
  onProgress?: (p: EngineProgress) => void;
  shouldCancel?: () => boolean;
  /** Aborted on cancel: interrupts in-flight transfers immediately. */
  signal?: AbortSignal;
}

const FAILED_SAMPLE_CAP = 100;
const RETRY_BASE_MS = Number(process.env.PDB_UPLOAD_RETRY_BASE_MS) || 2000;
const SESSION_EXPIRED_MSG =
  'Proton session expired — reconnect to Proton Drive to resume. Nothing was deleted and your backup set is unchanged.';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Minimal glob → RegExp ( * within a segment, ** across, ? one char ). */
function globToRegExp(glob: string): RegExp {
  let re = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&');
  re = re.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp(`^${re}$`, 'i');
}

/** True if rel (or its basename, or any path segment) matches an exclude glob. */
export function makeExcluder(patterns: string[]): (rel: string) => boolean {
  const res = patterns.filter((p) => p.trim()).map(globToRegExp);
  if (res.length === 0) return () => false;
  return (rel: string) => {
    const segs = rel.split('/');
    const base = segs[segs.length - 1];
    return res.some((r) => r.test(rel) || r.test(base) || segs.some((s) => r.test(s)));
  };
}

function hasAncestorIn(rel: string, set: Set<string>, includeSelf: boolean): boolean {
  if (includeSelf && set.has(rel)) return true;
  let dir = path.posix.dirname(rel);
  while (dir && dir !== '.') {
    if (set.has(dir)) return true;
    dir = path.posix.dirname(dir);
  }
  return false;
}

/** Entries with no ancestor also in the list (trashing a folder trashes its children). */
export function topMost<T extends { rel: string }>(entries: T[]): T[] {
  const all = new Set(entries.map((e) => e.rel));
  return entries.filter((e) => !hasAncestorIn(e.rel, all, false));
}

export function sha1File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    const s = createReadStream(abs, { highWaterMark: 1 << 20 });
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function makeSpeedMeter() {
  let lastT = Date.now();
  let lastB = 0;
  let rate = 0;
  return (total: number): number => {
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    if (dt >= 0.5) {
      const inst = Math.max(0, (total - lastB) / dt);
      rate = rate ? rate * 0.6 + inst * 0.4 : inst;
      lastT = now;
      lastB = total;
    }
    return rate;
  };
}

/** The rel-prefix for a source: "<set-folder>/<source path relative to LOCAL_ROOT>". */
export function relBaseFor(subfolder: string, abs: string): string {
  const rel = relToLocalRoot(abs);
  return rel ? `${subfolder}/${rel}` : subfolder;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 160);

/** Human reason for one file's failure (run summary / skipped-files panel). */
export function describeUploadError(e: unknown): string {
  const code = driveErrorCode(e);
  const fsCode = code ? undefined : (e as NodeJS.ErrnoException)?.code;
  if (fsCode && /^E[A-Z]+$/.test(fsCode)) return `not readable (${fsCode})`;
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'Proton session expired';
    case 'INVALID_NAME':
      return 'name not allowed by Proton Drive (at most 255 characters, no "/")';
    case 'QUOTA':
      return 'Drive storage is full';
    case 'NAME_CONFLICT':
      return 'a conflicting item already exists on Drive';
    case 'NETWORK':
      return 'network error talking to Proton';
    case 'RATE_LIMITED':
      return 'rate-limited by Proton';
    case 'INTEGRITY':
      return 'the file changed while it was being uploaded';
    case 'DECRYPTION':
      return 'Drive metadata could not be decrypted';
    default:
      return errMsg(e) || 'upload failed';
  }
}

const TRANSIENT = new Set(['NETWORK', 'RATE_LIMITED', 'SERVER', 'INTEGRITY', 'UNKNOWN']);

/* ------------------------------------------------------------------ */
/* Shared context: Drive folder resolution for one run                 */
/* ------------------------------------------------------------------ */

class RunContext {
  readonly prefix: string;
  readonly isExcluded: (rel: string) => boolean;
  /** rel dir → node uid, for this run (bounded; the catalog persists them). */
  private dirUids = new Map<string, string>();
  /** folder uid → children by name, for this run (bounded LRU). */
  private kids = new Map<string, Map<string, RemoteNode>>();
  setFolderUid = '';
  targetUid = '';

  constructor(
    readonly drive: DriveService,
    readonly spec: RunSpec,
    readonly seenAt: number,
    readonly write: boolean,
  ) {
    this.prefix = `${spec.subfolder}/`;
    const ex = makeExcluder(spec.excludes ?? []);
    // Exclude globs are authored relative to LOCAL_ROOT (no subfolder prefix).
    this.isExcluded = (rel) => ex(rel.startsWith(this.prefix) ? rel.slice(this.prefix.length) : rel);
  }

  async childMap(folderUid: string, fresh = false): Promise<Map<string, RemoteNode>> {
    let m = this.kids.get(folderUid);
    if (m && !fresh) {
      this.kids.delete(folderUid);
      this.kids.set(folderUid, m);
      return m;
    }
    m = new Map();
    for await (const n of this.drive.children(folderUid)) if (n.name !== null) m.set(n.name, n);
    this.kids.set(folderUid, m);
    while (this.kids.size > 256) this.kids.delete(this.kids.keys().next().value!);
    return m;
  }

  forgetDir(rel: string) {
    const uid = this.dirUids.get(rel);
    this.dirUids.delete(rel);
    if (uid) this.kids.delete(uid);
    if (this.write) catalog.setNodeUid(this.spec.setId, rel, null);
  }

  /**
   * Node uid of the Drive folder for catalog dir `rel`, resolving (and with
   * `create`, creating) the chain below the set folder. Returns null if it does
   * not exist and `create` is false (or this is a dry run).
   */
  async dirUid(rel: string, create: boolean): Promise<string | null> {
    if (rel === this.spec.subfolder) return this.setFolderUid;
    const hit = this.dirUids.get(rel);
    if (hit) return hit;
    const row = catalog.getDir(this.spec.setId, rel);
    if (row?.nodeUid) {
      this.remember(rel, row.nodeUid);
      return row.nodeUid;
    }
    const parentRel = path.posix.dirname(rel);
    const parent = await this.dirUid(parentRel === '.' ? this.spec.subfolder : parentRel, create);
    if (!parent) return null;
    const name = path.posix.basename(rel);
    const kids = await this.childMap(parent);
    let n = kids.get(name);
    if (n && n.kind !== 'folder') throw new DriveError('NAME_CONFLICT', `a file named "${name}" is where a folder belongs`);
    if (!n) {
      if (!create || !this.write) return null;
      n = await this.drive.createFolder(parent, name);
      kids.set(name, n);
    }
    if (this.write) catalog.upsertDir(this.spec.setId, rel, this.seenAt, n.uid);
    this.remember(rel, n.uid);
    return n.uid;
  }

  private remember(rel: string, uid: string) {
    this.dirUids.set(rel, uid);
    if (this.dirUids.size > 20_000) this.dirUids.delete(this.dirUids.keys().next().value!);
  }

  /** Resolve an absolute Proton path ("/my-files/a/b") from the root. */
  async resolvePath(p: string): Promise<RemoteNode | null> {
    let node = await this.drive.root();
    const segs = p.replace(/^\/my-files\/?/, '').split('/').filter(Boolean);
    for (const s of segs) {
      const next = (await this.childMap(node.uid, true)).get(s);
      if (!next) return null;
      node = next;
    }
    return node;
  }
}

/**
 * Find (or create) the set's own folder and check it is still the one the set
 * wrote to before. Returns an error message when the run must not write.
 */
async function bindSetFolder(ctx: RunContext, log: (m: string) => void): Promise<string | null> {
  const { spec, drive } = ctx;
  const set = backupSets.get(spec.setId);
  const known = set?.folderUid ?? null;
  const hasCatalog = catalog.count(spec.setId) > 0;
  const where = `"${spec.targetPath.replace(/^\/my-files/, '') || '/'}/${spec.subfolder}"`;

  if (known) {
    const n = await drive.getNode(known);
    if (n && !n.trashed && n.kind === 'folder' && n.parentUid === ctx.targetUid) {
      if (n.name && n.name !== spec.subfolder) {
        // Same node, renamed on Drive: follow it (the identity is the node, not the name).
        log(`The set's Drive folder was renamed to "${n.name}" — following it.`);
        if (ctx.write) backupSets.renameSubfolder(spec.setId, spec.subfolder, n.name);
        spec.subfolder = n.name;
      }
      ctx.setFolderUid = n.uid;
      return null;
    }
    if (hasCatalog) {
      return n?.trashed
        ? `The set's Drive folder ${where} is in the Drive trash — nothing was uploaded. Restore it from the trash, or run Verify to start this set over.`
        : `The set's Drive folder ${where} was deleted or moved on Drive — nothing was uploaded. Run Verify to re-check this set; it will re-upload what Drive is missing.`;
    }
    if (ctx.write) backupSets.setFolderUid(spec.setId, null);
  }

  const existing = (await ctx.childMap(ctx.targetUid, true)).get(spec.subfolder);
  if (existing && existing.kind !== 'folder') return `A file named "${spec.subfolder}" is in the way of the set's Drive folder.`;
  if (existing) {
    ctx.setFolderUid = existing.uid;
    if (ctx.write) backupSets.setFolderUid(spec.setId, existing.uid);
    return null;
  }
  if (hasCatalog) {
    return `The set's Drive folder ${where} was not found (renamed or deleted on Drive?) — nothing was uploaded. Run Verify to re-check this set.`;
  }
  if (!ctx.write) return null; // dry run of a brand-new set: the folder would be created
  const created = await drive.createFolder(ctx.targetUid, spec.subfolder);
  ctx.setFolderUid = created.uid;
  backupSets.setFolderUid(spec.setId, created.uid);
  return null;
}

/* ------------------------------------------------------------------ */
/* Deletion planner (shared by mirror runs and the dry run)            */
/* ------------------------------------------------------------------ */

interface DeletionOutcome {
  deleted: number;
  wouldDelete: string[];
  wouldDeleteCount: number;
  kept: { rel: string; reason: string }[];
  failed: number;
  sessionDead: boolean;
}

async function planAndDelete(ctx: RunContext, stale: CatalogEntry[], cancelled: () => boolean, log: (m: string) => void): Promise<DeletionOutcome> {
  const out: DeletionOutcome = { deleted: 0, wouldDelete: [], wouldDeleteCount: 0, kept: [], failed: 0, sessionDead: false };
  const { spec, drive } = ctx;
  const staleSet = new Map(stale.map((e) => [e.rel, e]));
  const dropRows = (rel: string) => {
    if (!ctx.write) return;
    const gone = stale.filter((s) => s.rel === rel || s.rel.startsWith(rel + '/')).map((s) => s.rel);
    catalog.remove(spec.setId, gone);
  };
  const batch: { uid: string; rel: string }[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const items = batch.splice(0);
    const res = await drive.trash(items.map((b) => b.uid));
    for (const r of res) {
      const item = items.find((b) => b.uid === r.uid);
      if (!item) continue;
      if (r.ok) {
        out.deleted++;
        dropRows(item.rel);
      } else if (r.code === 'UNAUTHENTICATED') {
        out.sessionDead = true;
      } else {
        out.failed++;
        log(`  could not trash ${item.rel}: ${r.error ?? 'error'}`);
      }
    }
  };

  /** Does the remote folder contain anything that is not in our catalog? */
  const hasForeign = async (dirUid: string, dirRel: string): Promise<boolean> => {
    for (const child of (await ctx.childMap(dirUid, true)).values()) {
      const rel = `${dirRel}/${child.name}`;
      const kind = child.kind === 'folder' ? 'dir' : 'file';
      const known = staleSet.get(rel) ?? (kind === 'dir' ? catalog.getDir(spec.setId, rel) : catalog.getFile(spec.setId, rel));
      if (!known) return true;
      if (child.kind === 'folder' && (await hasForeign(child.uid, rel))) return true;
    }
    return false;
  };

  const visit = async (e: CatalogEntry): Promise<void> => {
    if (cancelled() || out.sessionDead) return;
    if (e.rel === spec.subfolder) return; // never the set folder itself
    const parentRel = path.posix.dirname(e.rel);
    const parentUid = await ctx.dirUid(parentRel === '.' ? spec.subfolder : parentRel, false);
    const name = path.posix.basename(e.rel);
    if (!parentUid) {
      dropRows(e.rel); // the parent is already gone on Drive
      return;
    }
    const uid = e.nodeUid ?? (await ctx.childMap(parentUid)).get(name)?.uid ?? null;
    const node = uid ? await drive.getNode(uid) : null;
    if (!node || node.trashed) {
      dropRows(e.rel); // already gone — nothing to do
      return;
    }
    if (node.parentUid !== parentUid || node.name !== name || (node.kind === 'folder') !== (e.kind === 'dir')) {
      out.kept.push({ rel: e.rel, reason: 'changed on Drive by someone else' });
      log(`  kept ${e.rel}: it was moved, renamed or replaced on Drive`);
      dropRows(e.rel); // no longer ours to manage
      return;
    }
    if (e.kind === 'dir' && (await hasForeign(node.uid, e.rel))) {
      out.kept.push({ rel: e.rel, reason: 'contains files this backup did not upload' });
      log(`  kept folder ${e.rel}: it contains items this backup did not upload; trashing only ours`);
      for (const child of stale) {
        if (path.posix.dirname(child.rel) === e.rel) await visit(child);
      }
      if (ctx.write) catalog.upsertDir(spec.setId, e.rel, ctx.seenAt, node.uid); // the folder stays
      return;
    }
    out.wouldDeleteCount++;
    if (out.wouldDelete.length < 500) out.wouldDelete.push(e.rel);
    if (!ctx.write) return;
    batch.push({ uid: node.uid, rel: e.rel });
    if (batch.length >= 50) await flush();
  };

  try {
    for (const e of topMost(stale)) {
      if (cancelled() || out.sessionDead) break;
      await visit(e);
    }
    if (!cancelled() && !out.sessionDead) await flush();
  } catch (err) {
    if (driveErrorCode(err) === 'UNAUTHENTICATED') out.sessionDead = true;
    else throw err;
  }
  return out;
}

/** Gates that must ALL pass before anything is deleted. Returns the reason to skip, or null. */
async function deletionGate(
  spec: RunSpec,
  marksNow: Record<string, { exists: boolean; mounted: boolean; nonEmpty: boolean }>,
  failedCount: number,
  staleCount: number,
  total: number,
  pct: number | null,
): Promise<string | null> {
  const before = backupSets.get(spec.setId)?.sourceMarks ?? {};
  for (const abs of spec.sourcePaths) {
    const now = marksNow[abs];
    if (!now?.exists) return `source "${relToLocalRoot(abs) || abs}" is missing on disk (mount offline?)`;
    const prev: SourceMark | undefined = before[abs];
    if (prev?.mounted && !now.mounted) return `source "${relToLocalRoot(abs) || abs}" is no longer a mounted share (NAS offline?)`;
    if (!now.nonEmpty && (prev?.nonEmpty ?? true) && !spec.allowEmptySource) {
      return `source "${relToLocalRoot(abs) || abs}" is empty — if you emptied it on purpose, confirm the deletion in the set's menu`;
    }
  }
  if (failedCount > 0) return `${failedCount} file(s) failed to upload — "gone locally" can't be trusted until uploads succeed`;
  if (pct !== null && total > 0 && staleCount / total > pct) {
    return `${staleCount}/${total} entries (>${Math.round(pct * 100)}%) would be removed`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The run                                                              */
/* ------------------------------------------------------------------ */

export async function runSet(drive: DriveService, specIn: RunSpec, hooks: RunHooks = {}): Promise<DeltaResult> {
  const spec = { ...specIn };
  const log = hooks.log ?? (() => {});
  const shouldCancel = hooks.shouldCancel ?? (() => false);
  const mirrorCfg = getMirrorSafetyConfig();
  const DELETE_SAFETY_PCT = mirrorCfg.enabled ? mirrorCfg.deleteSafetyPct : null;
  const seenAt = Math.max(Date.now(), catalog.maxSeenAt(spec.setId) + 1);
  const ctx = new RunContext(drive, spec, seenAt, true);

  let newCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  let adoptedCount = 0;
  let failedCount = 0;
  let doneFiles = 0;
  let doneBytes = 0;
  let cancelled = false;
  let sessionDead = false;
  const failedFiles: SkippedFile[] = [];
  const speed = makeSpeedMeter();
  let lastReport = 0;
  const report = (current: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    hooks.onProgress?.({ doneFiles, totalFiles: 0, doneBytes, totalBytes: 0, current, bytesPerSec: speed(doneBytes) });
  };
  const noteFailed = (rel: string, reason: string) => {
    failedCount++;
    if (failedFiles.length < FAILED_SAMPLE_CAP) failedFiles.push({ rel, reason });
    log(`  skipped: ${rel} — ${reason}`);
  };
  const result = (message: string, extra: Partial<DeltaResult> = {}): DeltaResult => ({
    ok: false,
    cancelled,
    newCount,
    changedCount,
    unchangedCount,
    adoptedCount,
    deletedCount: 0,
    failedCount,
    failedFiles,
    uploadedBytes: doneBytes,
    deletionSkipped: null,
    message,
    ...extra,
  });

  // 1. Target and set folder.
  log('Checking the Drive target…');
  const target = await ctx.resolvePath(spec.targetPath);
  if (!target || target.kind !== 'folder') {
    const shown = spec.targetPath.replace(/^\/my-files/, '') || '/';
    return result(`Target "Drive${shown}" no longer exists on Drive - backup did NOT run. Recreate the folder or change the target.`);
  }
  ctx.targetUid = target.uid;
  const bindErr = await bindSetFolder(ctx, log);
  if (bindErr) return result(bindErr);

  // 2. Sources (also the mount marks the mirror gate compares against next time).
  const marksNow: Record<string, { exists: boolean; mounted: boolean; nonEmpty: boolean }> = {};
  for (const abs of spec.sourcePaths) marksNow[abs] = await sourceMark(abs);

  // 3. Upload pool: bounded files in flight (live-tunable), shared speed limit.
  let capAt = 0;
  let cap = 2;
  const maxInflight = () => {
    if (Date.now() - capAt > 1000) {
      cap = Math.max(1, Math.min(8, getUploadConfig().concurrency || 2));
      capAt = Date.now();
    }
    return cap;
  };
  const throttle = makeThrottle(() => getUploadConfig().limitKBps);
  const inflight = new Set<Promise<void>>();
  const schedule = async (task: () => Promise<void>) => {
    while (inflight.size >= maxInflight()) await Promise.race(inflight);
    const p = task().finally(() => inflight.delete(p));
    inflight.add(p);
  };

  const record = (rel: string, size: number, mtimeMs: number, sha1: string | null, uid: string | null) => {
    catalog.upsertFile(spec.setId, rel, size, mtimeMs, sha1, seenAt, uid);
  };

  /** Same content on Drive as on disk? Reads the local file only when size (and, if asked, mtime) already match. */
  const sameContent = async (remote: RemoteNode, abs: string, size: number, mtimeMs: number, requireMtime: boolean) => {
    if (remote.kind !== 'file' || remote.size !== size || !remote.sha1) return false;
    if (requireMtime && (remote.mtimeMs === null || Math.abs(remote.mtimeMs - mtimeMs) > 2000)) return false;
    return (await sha1File(abs)) === remote.sha1;
  };

  /** Upload one file (new or changed), with reconciliation and retries. */
  const processFile = async (f: { abs: string; rel: string; size: number; mtimeMs: number }, verdict: 'new' | 'changed', cat?: CatalogFile) => {
    const relDir = path.posix.dirname(f.rel);
    const name = path.posix.basename(f.rel);
    const opts = {
      mediaType: mediaTypeFor(name),
      thumbnails: !spec.skipThumbnails,
      signal: hooks.signal,
      throttle,
      onProgress: (() => {
        let last = 0;
        return (b: number) => {
          doneBytes += b - last;
          last = b;
          report('/' + relDir);
        };
      })(),
    };
    for (let attempt = 1; ; attempt++) {
      try {
        let parentUid = await ctx.dirUid(relDir, true);
        if (!parentUid) throw new DriveError('NOT_FOUND', 'parent folder missing');
        let nodeUid = cat?.nodeUid ?? null;
        if (verdict === 'changed' && !nodeUid) nodeUid = (await ctx.childMap(parentUid)).get(name)?.uid ?? null;

        if (verdict === 'changed' && nodeUid) {
          const remote = await drive.getNode(nodeUid);
          if (!remote || remote.trashed || remote.parentUid !== parentUid || remote.kind !== 'file') {
            nodeUid = null; // gone or no longer ours where it was: upload as a new file
          } else if (await sameContent(remote, f.abs, f.size, f.mtimeMs, true)) {
            record(f.rel, f.size, f.mtimeMs, remote.sha1, remote.uid);
            adoptedCount++;
            changedCount--;
            unchangedCount++;
            return;
          }
        }

        let res;
        if (nodeUid) {
          res = await drive.uploadRevision(nodeUid, f, opts);
        } else {
          try {
            res = await drive.uploadNew(parentUid, name, f, opts);
          } catch (e) {
            if (!(e instanceof Error) || driveErrorCode(e) !== 'NAME_CONFLICT') throw e;
            const c = e as DriveError;
            if (c.existingIsDraft) {
              res = await drive.uploadNew(parentUid, name, f, { ...opts, overrideDraft: true });
            } else {
              const ex = c.existingUid ? await drive.getNode(c.existingUid) : null;
              if (!ex) throw e;
              if (ex.kind !== 'file') throw new DriveError('NAME_CONFLICT', `a folder named "${name}" already exists on Drive`);
              if (await sameContent(ex, f.abs, f.size, f.mtimeMs, false)) {
                record(f.rel, f.size, f.mtimeMs, ex.sha1, ex.uid);
                adoptedCount++;
                if (verdict === 'new') newCount--;
                else changedCount--;
                unchangedCount++;
                return;
              }
              if (spec.mode === 'add') {
                // Add never updates. Record what Drive has (NOT the local stat), so a
                // later switch to Backup still sees the difference and uploads it.
                record(f.rel, ex.size ?? -1, ex.mtimeMs ?? 0, ex.sha1, ex.uid);
                newCount--;
                unchangedCount++;
                return;
              }
              res = await drive.uploadRevision(ex.uid, f, opts);
            }
          }
        }
        record(f.rel, f.size, f.mtimeMs, res.sha1, res.nodeUid);
        doneFiles++;
        // Changed while we read it? The catalog holds the digest of what was really
        // uploaded, so the next run sees the new mtime, hashes, and uploads again.
        const after = await fsp.stat(f.abs).catch(() => null);
        if (after && (after.size !== f.size || Math.abs(after.mtimeMs - f.mtimeMs) > 1)) {
          log(`  note: ${f.rel} changed during upload; the next run uploads the newer version`);
        }
        return;
      } catch (e) {
        const code = driveErrorCode(e);
        if (code === 'UNAUTHENTICATED') {
          sessionDead = true;
          return;
        }
        if (code === 'CANCELLED' || shouldCancel()) return;
        if (code === 'NOT_FOUND' && attempt === 1) {
          // A cached folder uid went stale (folder deleted on Drive): resolve again.
          ctx.forgetDir(relDir);
          continue;
        }
        const fsCode = code ? undefined : (e as NodeJS.ErrnoException)?.code; // DriveError has .code too
        if (fsCode === 'ENOENT') return; // deleted locally since the walk — not a failure
        if (code && TRANSIENT.has(code) && attempt < 4 && !fsCode) {
          const wait = RETRY_BASE_MS * 4 ** (attempt - 1);
          log(`  ${f.rel}: ${describeUploadError(e)} — retry ${attempt}/3 in ${Math.round(wait / 1000)}s`);
          for (let w = 0; w < wait && !shouldCancel(); w += 250) await sleep(Math.min(250, wait));
          continue;
        }
        noteFailed(f.rel, describeUploadError(e));
        return;
      }
    }
  };

  // 4. Walk + diff. "Seen" marks for mirror are buffered and flushed in one transaction.
  const touchBuf: string[] = [];
  const seenDirs = new Set<string>();
  const flushTouches = () => {
    if (touchBuf.length === 0) return;
    catalog.touchMany(spec.setId, touchBuf.splice(0), seenAt);
  };
  const touch = (rel: string) => {
    touchBuf.push(rel);
    let dir = path.posix.dirname(rel);
    while (dir && dir !== '.' && !seenDirs.has(dir)) {
      seenDirs.add(dir);
      touchBuf.push(dir);
      dir = path.posix.dirname(dir);
    }
    if (touchBuf.length >= 2000) flushTouches();
  };
  const pendingDirs: string[] = [];
  const drainDirs = async () => {
    while (pendingDirs.length && !sessionDead) {
      const rel = pendingDirs.shift()!;
      try {
        await ctx.dirUid(rel, true);
      } catch (e) {
        if (driveErrorCode(e) === 'UNAUTHENTICATED') sessionDead = true;
        else noteFailed(rel, describeUploadError(e));
      }
    }
  };

  log('Comparing against catalog…');
  report('scanning', true);
  outer: for (const abs of spec.sourcePaths) {
    const relBase = relBaseFor(spec.subfolder, abs);
    for await (const file of walkSourceStream(abs, relBase, {
      includeHidden: spec.includeHidden,
      onSkip: noteFailed,
      onDir: (rel) => {
        if (ctx.isExcluded(rel) && rel !== relBase) return;
        touch(rel);
        if (!catalog.getDir(spec.setId, rel)) pendingDirs.push(rel); // created on Drive below (empty folders too)
      },
    })) {
      if (shouldCancel()) {
        cancelled = true;
        break outer;
      }
      if (sessionDead) break outer;
      // Folders first (keeps empty folders mirrored).
      await drainDirs();
      if (ctx.isExcluded(file.rel)) {
        touch(file.rel);
        continue;
      }
      const cat = catalog.getFile(spec.setId, file.rel);
      let verdict = diffFile(file, cat);
      if (spec.mode === 'add' && cat) verdict = 'unchanged'; // add never updates
      if (verdict === 'hash') {
        // Same size, mtime drifted. Compare content: against our recorded digest, or
        // (catalog rows from CLI-era releases have none) against Drive's.
        let known = cat!.sha1;
        let uid = cat!.nodeUid ?? null;
        try {
          if (!known) {
            const parentUid = await ctx.dirUid(path.posix.dirname(file.rel), false);
            uid ??= parentUid ? ((await ctx.childMap(parentUid)).get(path.posix.basename(file.rel))?.uid ?? null) : null;
            const remote = uid ? await drive.getNode(uid) : null;
            known = remote && !remote.trashed ? remote.sha1 : null;
          }
          const local = known ? await sha1File(file.abs) : null;
          if (known && local === known) {
            unchangedCount++;
            record(file.rel, file.size, file.mtimeMs, local, uid); // refresh mtime: no hashing next time
            continue;
          }
        } catch (e) {
          if (driveErrorCode(e) === 'UNAUTHENTICATED') {
            sessionDead = true;
            break outer;
          }
          // Could not compare (unreadable/remote error): fall through and upload.
        }
        verdict = 'changed';
      }
      if (verdict === 'unchanged') {
        unchangedCount++;
        touch(file.rel);
        continue;
      }
      if (verdict === 'new') newCount++;
      else changedCount++;
      await schedule(() => processFile(file, verdict as 'new' | 'changed', cat));
    }
    if (cancelled || sessionDead) break;
    await drainDirs();
  }
  await Promise.all(inflight);
  if (shouldCancel()) cancelled = true;
  flushTouches(); // MUST precede stale(): an unflushed mark would look like a deletion
  report('', true);

  if (sessionDead) return result(SESSION_EXPIRED_MSG);

  // 5. Mirror deletions (never on cancel).
  let deletedCount = 0;
  let deletionSkipped: string | null = null;
  if (spec.mode === 'mirror' && !cancelled) {
    const stale = catalog.stale(spec.setId, seenAt).filter((s) => s.rel === spec.subfolder || s.rel.startsWith(ctx.prefix));
    if (stale.length) {
      deletionSkipped = await deletionGate(spec, marksNow, failedCount, stale.length, catalog.count(spec.setId), DELETE_SAFETY_PCT);
      if (deletionSkipped) {
        log(`Safety: ${deletionSkipped} — deletion skipped.`);
      } else {
        const d = await planAndDelete(ctx, stale, shouldCancel, log);
        deletedCount = d.deleted;
        failedCount += d.failed;
        if (d.sessionDead) return result(SESSION_EXPIRED_MSG, { deletedCount });
        if (d.deleted) log(`Moved ${d.deleted} item(s) no longer present locally to the Drive trash`);
      }
    }
  }

  // Remember how the sources looked, for the next run's mount check — but only after
  // a run that saw them intact, so an offline share can never become the reference.
  if (!cancelled && Object.values(marksNow).every((m) => m.exists && (m.nonEmpty || spec.allowEmptySource || !m.mounted))) {
    const marks: Record<string, SourceMark> = {};
    for (const [abs, m] of Object.entries(marksNow)) marks[abs] = { mounted: m.mounted, nonEmpty: m.nonEmpty };
    backupSets.setSourceMarks(spec.setId, marks);
  }

  const parts = [`${doneFiles} uploaded`, `${unchangedCount} unchanged`];
  if (adoptedCount) parts.push(`${adoptedCount} already on Drive`);
  if (spec.mode === 'mirror' && !cancelled && !deletionSkipped) parts.push(`${deletedCount} removed`);
  if (deletionSkipped) parts.push(`deletion skipped for safety (${deletionSkipped})`);
  if (failedCount) {
    const ex = failedFiles[0];
    parts.push(ex ? `${failedCount} failed (e.g. “${path.basename(ex.rel)}” — ${ex.reason})` : `${failedCount} failed`);
  }
  return {
    ok: failedCount === 0 && !cancelled && !deletionSkipped,
    cancelled,
    newCount,
    changedCount,
    unchangedCount,
    adoptedCount,
    deletedCount,
    failedCount,
    failedFiles,
    uploadedBytes: doneBytes,
    deletionSkipped,
    message: cancelled ? `Cancelled - ${parts.join(', ')}` : parts.join(', '),
  };
}

/* ------------------------------------------------------------------ */
/* Dry run                                                              */
/* ------------------------------------------------------------------ */

export interface PreviewResult {
  ok: boolean;
  mode: Mode;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  wouldUploadCount: number;
  wouldUploadBytes: number;
  wouldDelete: string[];
  wouldDeleteCount: number;
  wouldDeleteTruncated: boolean;
  deletionWouldSkip: string | null;
  message: string;
}

/**
 * What a run would do — the SAME scan, exclusions, verdicts and deletion planner
 * as runSet, with every write replaced by counting. It reads from Drive only for
 * the items a mirror run would delete (identity and foreign-content checks, same
 * as the live run) and never writes the catalog: "seen" marks go to a TEMP table.
 */
export async function previewSet(drive: DriveService, spec: RunSpec, shouldCancel: () => boolean = () => false): Promise<PreviewResult> {
  const mirrorCfg = getMirrorSafetyConfig();
  const DELETE_SAFETY_PCT = mirrorCfg.enabled ? mirrorCfg.deleteSafetyPct : null;
  const ctx = new RunContext(drive, { ...spec }, 0, false);
  const db = getDb();
  db.exec('CREATE TEMP TABLE IF NOT EXISTS preview_seen (rel TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM temp.preview_seen;');
  const ins = db.prepare('INSERT OR IGNORE INTO temp.preview_seen (rel) VALUES (?)');
  const seenDirs = new Set<string>();
  const touch = (rel: string) => {
    ins.run(rel);
    let dir = path.posix.dirname(rel);
    while (dir && dir !== '.' && !seenDirs.has(dir)) {
      seenDirs.add(dir);
      ins.run(dir);
      dir = path.posix.dirname(dir);
    }
  };

  let newCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  let wouldUploadBytes = 0;
  db.exec('BEGIN');
  try {
    for (const abs of spec.sourcePaths) {
      const relBase = relBaseFor(spec.subfolder, abs);
      for await (const file of walkSourceStream(abs, relBase, {
        includeHidden: spec.includeHidden,
        onDir: (rel) => {
          if (!ctx.isExcluded(rel) || rel === relBase) touch(rel);
        },
      })) {
        if (shouldCancel()) break;
        touch(file.rel);
        if (ctx.isExcluded(file.rel)) continue;
        const cat = catalog.getFile(spec.setId, file.rel);
        let verdict = diffFile(file, cat);
        if (spec.mode === 'add' && cat) verdict = 'unchanged';
        if (verdict === 'hash') {
          const local = cat!.sha1 ? await sha1File(file.abs).catch(() => null) : null;
          verdict = local && local === cat!.sha1 ? 'unchanged' : 'changed';
        }
        if (verdict === 'unchanged') unchangedCount++;
        else {
          if (verdict === 'new') newCount++;
          else changedCount++;
          wouldUploadBytes += file.size;
        }
      }
    }
  } finally {
    db.exec('COMMIT');
  }

  let wouldDelete: string[] = [];
  let wouldDeleteCount = 0;
  let deletionWouldSkip: string | null = null;
  if (spec.mode === 'mirror') {
    const stale = (
      db
        .prepare(
          `SELECT c.rel, c.kind, c.node_uid FROM backup_catalog c
           WHERE c.set_id = ? AND (c.rel = ? OR (c.rel > ? AND c.rel < ?))
             AND NOT EXISTS (SELECT 1 FROM temp.preview_seen s WHERE s.rel = c.rel)
           ORDER BY length(c.rel)`,
        )
        .all(spec.setId, spec.subfolder, spec.subfolder + '/', spec.subfolder + '0') as { rel: string; kind: 'file' | 'dir'; node_uid: string | null }[]
    ).map((r) => ({ rel: r.rel, kind: r.kind, nodeUid: r.node_uid }));
    if (stale.length) {
      const marksNow: Record<string, { exists: boolean; mounted: boolean; nonEmpty: boolean }> = {};
      for (const abs of spec.sourcePaths) marksNow[abs] = await sourceMark(abs);
      deletionWouldSkip = await deletionGate(spec, marksNow, 0, stale.length, catalog.count(spec.setId), DELETE_SAFETY_PCT);
      if (!deletionWouldSkip) {
        const target = await ctx.resolvePath(spec.targetPath);
        const set = backupSets.get(spec.setId);
        ctx.targetUid = target?.uid ?? '';
        ctx.setFolderUid = set?.folderUid ?? (target ? ((await ctx.childMap(target.uid)).get(spec.subfolder)?.uid ?? '') : '');
        if (ctx.setFolderUid) {
          const plan = await planAndDelete(ctx, stale, shouldCancel, () => {});
          wouldDelete = plan.wouldDelete;
          wouldDeleteCount = plan.wouldDeleteCount;
        }
      }
    }
  }
  db.exec('DELETE FROM temp.preview_seen');

  const wouldUploadCount = newCount + changedCount;
  const parts = [`${wouldUploadCount} to upload`, `${unchangedCount} unchanged`];
  if (spec.mode === 'mirror') parts.push(deletionWouldSkip ? `deletion skipped for safety (${deletionWouldSkip})` : `${wouldDeleteCount} to remove`);
  return {
    ok: true,
    mode: spec.mode,
    newCount,
    changedCount,
    unchangedCount,
    wouldUploadCount,
    wouldUploadBytes,
    wouldDelete,
    wouldDeleteCount,
    wouldDeleteTruncated: wouldDeleteCount > wouldDelete.length,
    deletionWouldSkip,
    message: parts.join(' · '),
  };
}

/* ------------------------------------------------------------------ */
/* Verify                                                               */
/* ------------------------------------------------------------------ */

export interface VerifyResult {
  ok: boolean;
  checked: number;
  /** Catalog entries dropped (missing or different on Drive) → re-uploaded next run. */
  repaired: number;
  /** Content verify only: files whose local SHA-1 differs from Drive's. */
  contentMismatches: number;
  /** Items on Drive inside the set's folder that this backup did not upload. */
  foreign: number;
  message: string;
}

/**
 * Reconcile the catalog with Drive (opt-in; this is the full remote scan the
 * catalog otherwise avoids). Walks the set's Drive folder one folder at a time —
 * memory is bounded by one folder listing, not by the set size — and:
 *  - drops catalog entries Drive does not have (or has with another size), so the
 *    next run re-uploads them; never deletes anything on Drive;
 *  - fills in Drive node ids for catalog rows written by CLI-era releases;
 *  - with `content`, also reads every local file and compares its SHA-1 with the
 *    digest Drive stores for the revision. This is the full content check that
 *    detects changes the fast delta cannot see (same size AND same mtime).
 * Any listing error other than Drive's explicit "not found" aborts without
 * touching the catalog.
 */
export async function verifySet(
  drive: DriveService,
  spec: RunSpec,
  opts: { content?: boolean; log?: (m: string) => void; shouldCancel?: () => boolean } = {},
): Promise<VerifyResult> {
  const log = opts.log ?? (() => {});
  const cancelled = opts.shouldCancel ?? (() => false);
  const ctx = new RunContext(drive, { ...spec }, Date.now(), true);
  const empty = (message: string, ok = false): VerifyResult => ({ ok, checked: 0, repaired: 0, contentMismatches: 0, foreign: 0, message });

  const target = await ctx.resolvePath(spec.targetPath);
  if (!target) return empty('Verify aborted: the target folder does not exist on Drive.');
  const set = backupSets.get(spec.setId);
  let folder: RemoteNode | null = set?.folderUid ? await drive.getNode(set.folderUid) : null;
  if (folder && (folder.trashed || folder.parentUid !== target.uid)) folder = null;
  folder ??= (await ctx.childMap(target.uid, true)).get(spec.subfolder) ?? null;
  if (!folder || folder.kind !== 'folder') {
    // The set's folder is gone: the whole catalog is void. Reset it so the next
    // run creates the folder and uploads everything again (explicit user action).
    const n = catalog.count(spec.setId);
    catalog.clear(spec.setId);
    backupSets.setFolderUid(spec.setId, null);
    return { ok: true, checked: n, repaired: n, contentMismatches: 0, foreign: 0, message: `The set's Drive folder is missing — ${n} entries reset; the next run uploads everything again.` };
  }
  backupSets.setFolderUid(spec.setId, folder.uid);
  catalog.upsertDir(spec.setId, spec.subfolder, catalog.maxSeenAt(spec.setId), folder.uid);

  let checked = 0;
  let repaired = 0;
  let contentMismatches = 0;
  let foreign = 0;
  const drop: string[] = [];
  const flushDrop = () => {
    if (drop.length) catalog.remove(spec.setId, drop.splice(0));
  };

  // Depth-first over catalog dirs that exist on Drive.
  const stack: { rel: string; uid: string }[] = [{ rel: spec.subfolder, uid: folder.uid }];
  log('Scanning Drive…');
  while (stack.length && !cancelled()) {
    const { rel, uid } = stack.pop()!;
    const remote = await ctx.childMap(uid, true);
    const seen = new Set<string>();
    for (const row of catalog.children(spec.setId, rel)) {
      if (cancelled()) break;
      const name = path.posix.basename(row.rel);
      seen.add(name);
      const r = remote.get(name);
      if (row.kind === 'dir') {
        if (r && r.kind === 'folder') {
          if (row.nodeUid !== r.uid) catalog.setNodeUid(spec.setId, row.rel, r.uid);
          stack.push({ rel: row.rel, uid: r.uid });
        } else {
          // Folder gone on Drive: everything below it must be uploaded again.
          drop.push(row.rel);
          for (const d of catalog.children(spec.setId, row.rel)) drop.push(d.rel);
          repaired++;
        }
        continue;
      }
      checked++;
      if (!r || r.kind !== 'file' || (r.size !== null && r.size !== row.size)) {
        drop.push(row.rel);
        repaired++;
        continue;
      }
      if (row.nodeUid !== r.uid) catalog.setNodeUid(spec.setId, row.rel, r.uid);
      if (opts.content) {
        const abs = localAbsFor(spec, row.rel);
        const local = abs ? await sha1File(abs).catch(() => null) : null;
        if (local && r.sha1 && local !== r.sha1) {
          contentMismatches++;
          drop.push(row.rel);
          repaired++;
          log(`  content differs: ${row.rel}`);
        }
      }
      if (drop.length >= 1000) flushDrop();
    }
    for (const name of remote.keys()) if (!seen.has(name)) foreign++;
    if (cancelled()) break;
  }
  if (cancelled()) return empty('Cancelled');
  flushDrop();
  const message =
    `${checked} checked · ${repaired} to re-upload on next run` +
    (opts.content ? ` · ${contentMismatches} content mismatch(es)` : '') +
    (foreign ? ` · ${foreign} item(s) on Drive not uploaded by this set` : '');
  log(message);
  return { ok: true, checked, repaired, contentMismatches, foreign, message };
}

/** Local path of a catalog rel, if it lies inside one of the set's sources. */
function localAbsFor(spec: RunSpec, rel: string): string | null {
  for (const abs of spec.sourcePaths) {
    const base = relBaseFor(spec.subfolder, abs);
    if (rel === base) return abs;
    if (rel.startsWith(base + '/')) return path.join(abs, rel.slice(base.length + 1));
  }
  return null;
}
