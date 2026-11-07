import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { walkSourceStream, relToLocalRoot, sourceMark } from './local';
import { catalog, diffFile, type CatalogEntry, type CatalogFile } from './catalog';
import { backupSets, type SourceMark } from './db';
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
  /** One-shot: the user confirmed the sources' current state (emptied on purpose,
   *  mounts changed on purpose); it becomes the new reference. */
  confirmSources?: boolean;
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
    case 'FOLDER_FULL':
      return 'the Drive folder has reached Proton Drive\'s limit of items per folder — files in it are skipped (exclude this folder, or split it locally)';
    case 'TOO_DEEP':
      return 'folders are nested deeper than Proton Drive allows';
    case 'FILE_TOO_LARGE':
      return 'the file is larger than the Proton plan allows';
    default:
      return errMsg(e) || 'upload failed';
  }
}

const TRANSIENT = new Set(['NETWORK', 'RATE_LIMITED', 'SERVER', 'INTEGRITY', 'UNKNOWN']);

/** Refusals that no retry will change: the whole folder is affected for the rest of the run. */
function isPermanentFolderError(e: unknown): boolean {
  const c = driveErrorCode(e);
  return c === 'FOLDER_FULL' || c === 'TOO_DEEP';
}

/* ------------------------------------------------------------------ */
/* Shared context: Drive folder resolution for one run                 */
/* ------------------------------------------------------------------ */

class RunContext {
  readonly isExcluded: (rel: string) => boolean;
  /** rel dir → node uid, for this run (bounded; the catalog persists them). */
  private dirUids = new Map<string, string>();
  /** folder uid → children by name, for this run (bounded LRU). */
  private kids = new Map<string, Map<string, RemoteNode>>();
  setFolderUid = '';
  targetUid = '';
  /** Folders this run created: known to be empty, no listing needed. */
  private created = new Set<string>();
  /** rel dir → permanent Drive refusal (folder full, too deep): skip without requests. */
  private blocked = new Map<string, DriveError>();

  constructor(
    readonly drive: DriveService,
    readonly spec: RunSpec,
    readonly seenAt: number,
    readonly write: boolean,
  ) {
    const ex = makeExcluder(spec.excludes ?? []);
    // Exclude globs are authored relative to LOCAL_ROOT (no subfolder prefix). The
    // prefix is read live: a run may follow a rename of the set folder.
    this.isExcluded = (rel) => {
      const prefix = this.prefix;
      return ex(rel.startsWith(prefix) ? rel.slice(prefix.length) : rel);
    };
  }

  get prefix(): string {
    return `${this.spec.subfolder}/`;
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

  /** The permanent refusal recorded for `rel` or one of its ancestors, if any. */
  blockedError(rel: string): DriveError | null {
    for (let d = rel; d && d !== '.'; d = path.posix.dirname(d)) {
      const e = this.blocked.get(d);
      if (e) return e;
    }
    return null;
  }

  block(rel: string, e: DriveError) {
    this.blocked.set(rel, e);
  }

  wasCreated(uid: string): boolean {
    return this.created.has(uid);
  }

  /** Record a node we just uploaded in the cached listing of its folder. */
  noteChild(folderUid: string, node: RemoteNode) {
    this.kids.get(folderUid)?.set(node.name ?? '', node);
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
      try {
        n = await this.drive.createFolder(parent, name);
      } catch (e) {
        if (isPermanentFolderError(e)) this.blocked.set(rel, e as DriveError);
        throw e;
      }
      kids.set(name, n);
      this.created.add(n.uid);
      this.kids.set(n.uid, new Map());
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
  const dropRows = (rel: string) => {
    if (ctx.write) catalog.removeTree(spec.setId, rel);
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
      const known = kind === 'dir' ? catalog.getDir(spec.setId, rel) : catalog.getFile(spec.setId, rel);
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
      // Only the items we uploaded go, one by one. The removed folder's own
      // catalog children ARE what this backup uploaded there.
      for (const child of catalog.children(spec.setId, e.rel)) await visit({ rel: child.rel, kind: child.kind, nodeUid: child.nodeUid });
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

type MarksNow = Record<string, { exists: boolean; mounted: boolean; nonEmpty: boolean }>;

/**
 * Do the sources look like they did after the last good run? Returns why not, or
 * null. An offline NAS share typically leaves its mountpoint behind as an EMPTY
 * directory of the parent filesystem: "was a mount, is not" and "had files, is
 * empty" both block deletion until the user confirms the new state once
 * (`confirmSources`). The reference state is only updated after a run whose
 * sources passed this check (or were confirmed) — never from an offline state.
 */
function sourceProblem(spec: RunSpec, marksNow: MarksNow): string | null {
  const before = backupSets.get(spec.setId)?.sourceMarks ?? {};
  for (const abs of spec.sourcePaths) {
    const now = marksNow[abs];
    const name = relToLocalRoot(abs) || abs;
    if (!now?.exists) return `source "${name}" is missing on disk (mount offline?)`;
    if (spec.confirmSources) continue;
    const prev: SourceMark | undefined = before[abs];
    if (prev?.mounted && !now.mounted) return `source "${name}" is no longer a mounted share (NAS offline?) — if you changed the mounts on purpose, confirm in the set's row`;
    if (!now.nonEmpty && (prev?.nonEmpty ?? true)) return `source "${name}" is empty — if you emptied it on purpose, confirm the deletion in the set's row`;
  }
  return null;
}

/** Gates that must ALL pass before anything is deleted. Returns the reason to skip, or null. */
function deletionGate(spec: RunSpec, marksNow: MarksNow, failedCount: number, staleCount: number, total: number, pct: number | null): string | null {
  const src = sourceProblem(spec, marksNow);
  if (src) return src;
  if (failedCount > 0) return `${failedCount} file(s) failed to upload — "gone locally" can't be trusted until uploads succeed`;
  if (pct !== null && total > 0 && staleCount / total > pct) {
    return `${staleCount}/${total} entries (>${Math.round(pct * 100)}%) would be removed`;
  }
  return null;
}

/**
 * Finds what was removed locally, one folder at a time, WITHOUT writing anything:
 * when the scan enters a folder it reports the folder's subfolder names, then its
 * files; when the next folder starts, the previous folder's catalog children
 * (parent index) are compared with what was seen. Memory is one folder's names.
 * Excluded entries are still walked and therefore count as present (= kept);
 * unreadable ones count as present too (and block deletion via the failure gate).
 * The same collector feeds the live run and the dry run.
 */
class RemovedCollector {
  readonly removed: CatalogEntry[] = [];
  private cur: { rel: string; files: Set<string>; dirs: Set<string> } | null = null;
  constructor(private readonly setId: string) {}
  enter(rel: string, subdirs: string[] | null) {
    this.finish();
    // An unreadable folder (null) is never diffed: nothing below it is "gone".
    this.cur = subdirs === null ? null : { rel, files: new Set(), dirs: new Set(subdirs) };
  }
  /** Name of `rel` if it is a direct child of the current folder (hot path: no path.* calls). */
  private child(rel: string): string | null {
    const c = this.cur;
    if (!c) return null;
    const n = c.rel.length;
    if (rel.length <= n + 1 || rel.charCodeAt(n) !== 47 || !rel.startsWith(c.rel)) return null;
    return rel.indexOf('/', n + 1) === -1 ? rel.slice(n + 1) : null;
  }
  seen(rel: string) {
    const name = this.child(rel);
    if (name !== null) this.cur!.files.add(name);
  }
  unreadable(rel: string) {
    const name = this.child(rel);
    if (name !== null) {
      this.cur!.files.add(name);
      this.cur!.dirs.add(name);
    }
  }
  finish() {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    const cut = c.rel.length + 1;
    for (const row of catalog.childNames(this.setId, c.rel)) {
      const name = row.rel.slice(cut);
      if (!(row.kind === 'file' ? c.files.has(name) : c.dirs.has(name))) this.removed.push({ rel: row.rel, kind: row.kind, nodeUid: row.node_uid });
    }
  }
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
  let scanned = 0;
  const report = (where: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    // The UI prefixes "<n> uploaded · <bytes>"; the scan counters make a long walk
    // over an unchanged (or already uploaded) tree visibly progress.
    const parts = [`${scanned.toLocaleString('en')} checked`, `${unchangedCount.toLocaleString('en')} unchanged`];
    if (adoptedCount) parts.push(`${adoptedCount.toLocaleString('en')} already on Drive`);
    if (failedCount) parts.push(`${failedCount.toLocaleString('en')} skipped`);
    if (where) parts.push(where);
    hooks.onProgress?.({ doneFiles, totalFiles: 0, doneBytes, totalBytes: 0, current: parts.join(' · '), bytesPerSec: speed(doneBytes) });
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
  const marksNow: MarksNow = {};
  for (const abs of spec.sourcePaths) marksNow[abs] = await sourceMark(abs);
  // A missing source must never look like a successful "0 uploaded" run.
  const missingSources = spec.sourcePaths.filter((abs) => !marksNow[abs].exists);

  // 3. Upload pool: bounded files in flight (live-tunable), shared speed limit.
  let capAt = 0;
  let cap = 2;
  const maxInflight = () => {
    if (Date.now() - capAt > 1000) {
      cap = Math.max(1, Math.min(5, getUploadConfig().concurrency || 2));
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
    if (remote.kind !== 'file' || remote.size !== size) return false;
    const sameTime = remote.mtimeMs !== null && Math.abs(remote.mtimeMs - mtimeMs) <= 2000;
    if (requireMtime && !sameTime) return false;
    // Size + modification time equal: the same evidence the delta itself trusts
    // (diffFile), so no full read — Drive stores the time the uploader claimed from
    // this very file. Only a same-size file with a different time is hashed.
    if (sameTime && !requireMtime) return true;
    if (!remote.sha1) return false;
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
    const done = (how: 'adopted' | 'kept') => {
      if (verdict === 'new') newCount--;
      else changedCount--;
      unchangedCount++;
      if (how === 'adopted') adoptedCount++;
      report('/' + relDir);
    };
    /**
     * Drive already has a file with this name. Same size and modification time as
     * on disk → it is this file (the same evidence the delta uses; e.g. uploaded by
     * the CLI release or by a run that died before recording it): record, no read,
     * no upload. Same size only → compare SHA-1 (one local read). Otherwise Add
     * keeps Drive's copy and Backup/Mirror write a new revision of that node.
     */
    const handleExisting = async (ex: RemoteNode, parentUid: string): Promise<boolean> => {
      if (ex.kind !== 'file') throw new DriveError('NAME_CONFLICT', `a folder named "${name}" already exists on Drive`);
      if (await sameContent(ex, f.abs, f.size, f.mtimeMs, false)) {
        record(f.rel, f.size, f.mtimeMs, ex.sha1, ex.uid);
        done('adopted');
        return true;
      }
      if (spec.mode === 'add') {
        // Add never updates. Record what Drive has (NOT the local stat), so a
        // later switch to Backup still sees the difference and uploads it.
        record(f.rel, ex.size ?? -1, ex.mtimeMs ?? 0, ex.sha1, ex.uid);
        done('kept');
        return true;
      }
      const res = await drive.uploadRevision(ex.uid, f, opts);
      finish(res, parentUid);
      return true;
    };
    const finish = (res: { nodeUid: string; sha1: string }, parentUid: string) => {
      record(f.rel, f.size, f.mtimeMs, res.sha1, res.nodeUid);
      ctx.noteChild(parentUid, { uid: res.nodeUid, parentUid, name, kind: 'file', size: f.size, mtimeMs: f.mtimeMs, sha1: res.sha1, mediaType: null, trashed: false });
      doneFiles++;
    };

    for (let attempt = 1; ; attempt++) {
      try {
        const refused = ctx.blockedError(relDir);
        if (refused) throw refused;
        const parentUid = await ctx.dirUid(relDir, true);
        if (!parentUid) throw new DriveError('NOT_FOUND', 'parent folder missing');
        let nodeUid = cat?.nodeUid ?? null;
        if (verdict === 'changed' && !nodeUid) nodeUid = (await ctx.childMap(parentUid)).get(name)?.uid ?? null;

        if (verdict === 'changed' && nodeUid) {
          const remote = await drive.getNode(nodeUid);
          if (!remote || remote.trashed || remote.parentUid !== parentUid || remote.kind !== 'file') {
            nodeUid = null; // gone or no longer ours where it was: upload as a new file
          } else if (await sameContent(remote, f.abs, f.size, f.mtimeMs, true)) {
            record(f.rel, f.size, f.mtimeMs, remote.sha1, remote.uid);
            done('adopted');
            return;
          }
        }

        if (nodeUid) {
          finish(await drive.uploadRevision(nodeUid, f, opts), parentUid);
        } else {
          // One listing per folder (cached) instead of one failed upload per file:
          // decisive after a CLI-era first upload that died before it was recorded.
          if (!ctx.wasCreated(parentUid)) {
            const ex = (await ctx.childMap(parentUid)).get(name);
            if (ex && (await handleExisting(ex, parentUid))) return;
          }
          try {
            finish(await drive.uploadNew(parentUid, name, f, opts), parentUid);
          } catch (e) {
            if (!(e instanceof Error) || driveErrorCode(e) !== 'NAME_CONFLICT') throw e;
            const c = e as DriveError;
            if (c.existingIsDraft) {
              finish(await drive.uploadNew(parentUid, name, f, { ...opts, overrideDraft: true }), parentUid);
            } else {
              const ex = c.existingUid ? await drive.getNode(c.existingUid) : null;
              if (!ex) throw e;
              await handleExisting(ex, parentUid);
              return;
            }
          }
        }
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
        if (isPermanentFolderError(e)) {
          // Never retried, and every other file of this folder is skipped at once.
          if (!ctx.blockedError(relDir)) {
            ctx.block(relDir, e as DriveError);
            log(`  ${relDir}: ${describeUploadError(e)}`);
          }
          noteFailed(f.rel, describeUploadError(e));
          return;
        }
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

  // 4. Walk + diff. Mirror finds local removals per folder (no per-file writes).
  const removed = spec.mode === 'mirror' ? new RemovedCollector(spec.setId) : null;
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
      onSkip: (rel, reason) => {
        removed?.unreadable(rel);
        noteFailed(rel, reason);
      },
      onDir: (rel, subdirs) => removed?.enter(rel, subdirs),
      // Folders are created on demand for the files in them; only truly EMPTY local
      // folders are created explicitly, so they are mirrored too.
      onEmptyDir: (rel) => {
        if (ctx.isExcluded(rel) && rel !== relBase) return;
        if (!catalog.getDir(spec.setId, rel)) pendingDirs.push(rel);
      },
    })) {
      if (shouldCancel()) {
        cancelled = true;
        break outer;
      }
      if (sessionDead) break outer;
      scanned++;
      report('scanning');
      // Folders first (keeps empty folders mirrored).
      await drainDirs();
      removed?.seen(file.rel);
      if (ctx.isExcluded(file.rel)) continue; // excluded = left alone (and kept on Drive)
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
      if (verdict === 'new' && spec.mode === 'add') {
        // Add mode: "exists on Drive" decides, never content. One listing per folder
        // (cached) instead of one request — or a full local read — per file. This is
        // also what CLI-era Add sets need after the upgrade: they had no catalog.
        try {
          const parentUid = await ctx.dirUid(path.posix.dirname(file.rel), false);
          const ex = parentUid ? (await ctx.childMap(parentUid)).get(path.posix.basename(file.rel)) : undefined;
          if (ex && ex.kind === 'file') {
            // Record what Drive has (not the local stat): Backup would still see a difference.
            record(file.rel, ex.size ?? -1, ex.mtimeMs ?? 0, ex.sha1, ex.uid);
            unchangedCount++;
            continue;
          }
        } catch (e) {
          if (driveErrorCode(e) === 'UNAUTHENTICATED') {
            sessionDead = true;
            break outer;
          }
          // Listing failed (network…): fall through — the upload's own name-conflict
          // handling still decides "exists" correctly, file by file.
        }
      }
      if (verdict === 'unchanged') {
        unchangedCount++;
        continue;
      }
      if (verdict === 'new') newCount++;
      else changedCount++;
      await schedule(() => processFile(file, verdict as 'new' | 'changed', cat));
    }
    if (cancelled || sessionDead) break;
    removed?.finish();
    await drainDirs();
  }
  await Promise.all(inflight);
  if (shouldCancel()) cancelled = true;
  report('', true);

  if (sessionDead) return result(SESSION_EXPIRED_MSG);

  // 5. Mirror deletions (never on cancel).
  let deletedCount = 0;
  let deletionSkipped: string | null = null;
  if (spec.mode === 'mirror' && !cancelled) {
    const stale = removed!.removed;
    if (stale.length || missingSources.length) {
      deletionSkipped = deletionGate(spec, marksNow, failedCount, stale.length, catalog.count(spec.setId), DELETE_SAFETY_PCT);
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
  // a run that saw them intact (or a confirmed change), so an offline share can
  // never become the reference.
  if (!cancelled && sourceProblem(spec, marksNow) === null) {
    const marks: Record<string, SourceMark> = {};
    for (const [abs, m] of Object.entries(marksNow)) marks[abs] = { mounted: m.mounted, nonEmpty: m.nonEmpty };
    backupSets.setSourceMarks(spec.setId, marks);
  }

  for (const abs of missingSources) noteFailed(relToLocalRoot(abs) || abs, 'source folder is missing on disk (NAS share offline?) — nothing from it was backed up');
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
 * as runSet (including the per-folder removal diff), with every write replaced by
 * counting. It reads from Drive only for the items a mirror run would delete
 * (identity and foreign-content checks, same as the live run).
 */
export async function previewSet(drive: DriveService, spec: RunSpec, shouldCancel: () => boolean = () => false): Promise<PreviewResult> {
  const mirrorCfg = getMirrorSafetyConfig();
  const DELETE_SAFETY_PCT = mirrorCfg.enabled ? mirrorCfg.deleteSafetyPct : null;
  const ctx = new RunContext(drive, { ...spec }, 0, false);
  const removed = spec.mode === 'mirror' ? new RemovedCollector(spec.setId) : null;
  let unreadable = 0;
  let newCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  let wouldUploadBytes = 0;
  for (const abs of spec.sourcePaths) {
    const relBase = relBaseFor(spec.subfolder, abs);
    for await (const file of walkSourceStream(abs, relBase, {
      includeHidden: spec.includeHidden,
      onDir: (rel, subdirs) => removed?.enter(rel, subdirs),
      onSkip: (rel) => {
        unreadable++;
        removed?.unreadable(rel);
      },
    })) {
      if (shouldCancel()) break;
      removed?.seen(file.rel);
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
    removed?.finish();
  }

  let wouldDelete: string[] = [];
  let wouldDeleteCount = 0;
  let deletionWouldSkip: string | null = null;
  if (removed && removed.removed.length) {
    const stale = removed.removed;
    const marksNow: MarksNow = {};
    for (const abs of spec.sourcePaths) marksNow[abs] = await sourceMark(abs);
    // Same gates as the live run; an unreadable entry counts like a failed upload.
    deletionWouldSkip = deletionGate(spec, marksNow, unreadable, stale.length, catalog.count(spec.setId), DELETE_SAFETY_PCT);
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
          repaired++;
          // Not dropped: size and time still match Drive, so a dropped row would be
          // re-adopted. An impossible mtime forces the next run to compare SHA-1 and
          // write a new revision of this node.
          catalog.upsertFile(spec.setId, row.rel, row.size ?? 0, -1, r.sha1, catalog.maxSeenAt(spec.setId), r.uid);
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
