import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { walkSourceStream, relToLocalRoot, type WalkedFile } from './local';
import { catalog, diffFile } from './catalog';
import { getUploadConfig, resolvePlan } from './upload-config';
import {
  createFolder,
  upload,
  trashDrive,
  listDrive,
  normalizeProtonPath,
  looksUnauthenticated,
  type FileStrategy,
  type RunResult,
} from './cli';

/** Message shown when a run stops because the Proton session expired mid-flight. */
const SESSION_EXPIRED_MSG =
  'Proton session expired — reconnect to Proton Drive to resume. Nothing was deleted and your backup set is unchanged.';

/**
 * Delta backup engine.
 *
 * Compares the local source tree against the Drive target and only uploads
 * files that are new or changed - so unchanged files (even 60 GB ones) are never
 * re-uploaded. Change detection: size first, then mtime (round-trips exactly via
 * the CLI's claimedModificationTime), then sha1 as a tie-breaker when only the
 * mtime drifted (Drive exposes claimedDigests.sha1 == the local file's sha1, so
 * no download is needed).
 *
 *  - mode 'backup': upload new + changed, never delete.
 *  - mode 'mirror': same, plus trash Drive items that no longer exist locally
 *    (scoped to the source subtrees, so unrelated Drive content is never touched).
 */

export interface DeltaResult {
  ok: boolean;
  cancelled: boolean;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  deletedCount: number;
  failedCount: number;
  message: string;
}

/** Minimal glob → RegExp ( * within a segment, ** across, ? one char ). */
function globToRegExp(glob: string): RegExp {
  let re = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&');
  re = re.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp(`^${re}$`, 'i');
}

/** True if rel (or its basename, or any path segment) matches an exclude glob. */
function makeExcluder(patterns: string[]): (rel: string) => boolean {
  const res = patterns.filter((p) => p.trim()).map(globToRegExp);
  if (res.length === 0) return () => false;
  return (rel: string) => {
    const segs = rel.split('/');
    const base = segs[segs.length - 1];
    return res.some((r) => r.test(rel) || r.test(base) || segs.some((s) => r.test(s)));
  };
}

function sha1File(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    const s = createReadStream(abs);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

export interface EngineProgress {
  doneFiles: number;
  totalFiles: number;
  doneBytes: number;
  totalBytes: number;
  current: string;
  bytesPerSec?: number;
}

/** Smoothed bytes/sec from a monotonically growing total, sampled ≥0.5s apart. */
function makeSpeedMeter() {
  let lastT = Date.now();
  let lastB = 0;
  let rate = 0;
  return (totalBytes: number): number => {
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    if (dt >= 0.5) {
      const inst = Math.max(0, (totalBytes - lastB) / dt);
      rate = rate ? rate * 0.6 + inst * 0.4 : inst;
      lastT = now;
      lastB = totalBytes;
    }
    return rate;
  };
}

/** The rel-prefix for a source: "<set-folder>/<source path relative to LOCAL_ROOT>". */
export function relBaseFor(subfolder: string, abs: string): string {
  const rel = relToLocalRoot(abs);
  return rel ? `${subfolder}/${rel}` : subfolder;
}

/**
 * Bulk-upload whole source trees while preserving their structure under
 * `<target>/<relBase>`. The CLI always names an uploaded folder after its
 * basename, so we never upload a source folder directly (its basename wouldn't
 * match the desired relBase). Instead:
 *   - a directory source → ensure `<target>/<relBase>` exists, then upload its
 *     (non-dot) immediate children into it; the CLI recurses each child.
 *   - a file source → upload it into `<target>/<dirname(relBase)>` (basename matches).
 * This keeps the layout exactly `<target>/<relBase>/…` regardless of basenames and
 * matches what the per-file engine/catalog records. Used by the fast first-run
 * seed and the lightweight 'add' mode. Returns the first failing CLI result, else
 * the last success.
 */
export async function uploadSourceTrees(
  sources: { abs: string; relBase: string }[],
  target: string,
  fileStrategy: FileStrategy,
  folderStrategy: FileStrategy,
  onUploadedFile?: (bytes: number) => void,
): Promise<RunResult> {
  // Ensure a "<target>/<relDir>" folder chain exists (idempotent, shallow→deep).
  const ensured = new Set<string>();
  const ensureChain = async (relDir: string) => {
    if (relDir === '' || relDir === '.') return;
    const parts = relDir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if (ensured.has(sub)) continue;
      ensured.add(sub);
      const parentRel = parts.slice(0, i - 1).join('/');
      await createFolder(parentRel ? `${target}/${parentRel}` : target, parts[i - 1]);
    }
  };

  let last: RunResult = { code: 0, stdout: '', stderr: '' };
  const run = async (absList: string[], parentDrive: string): Promise<boolean> => {
    if (absList.length === 0) return true;
    const res = await upload(absList, parentDrive, fileStrategy, folderStrategy, onUploadedFile);
    if (res.code !== 0) {
      last = res;
      return false;
    }
    last = res;
    return true;
  };

  // File sources grouped by destination parent dir (basename matches relBase).
  const fileGroups = new Map<string, string[]>();
  const dirSources: { abs: string; relBase: string }[] = [];
  for (const s of sources) {
    let st;
    try {
      st = await fsp.stat(s.abs);
    } catch {
      continue; // unreadable source → skip
    }
    if (st.isDirectory()) {
      dirSources.push(s);
    } else if (st.isFile()) {
      const parentRel = path.dirname(s.relBase);
      const arr = fileGroups.get(parentRel);
      if (arr) arr.push(s.abs);
      else fileGroups.set(parentRel, [s.abs]);
    }
  }

  for (const [parentRel, absList] of fileGroups) {
    await ensureChain(parentRel === '.' ? '' : parentRel);
    const parentDrive = parentRel === '.' ? target : `${target}/${parentRel}`;
    if (!(await run(absList, parentDrive))) return last;
  }

  for (const s of dirSources) {
    await ensureChain(s.relBase); // create <target>/<relBase> in full
    let ents;
    try {
      ents = await fsp.readdir(s.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    const children = ents.filter((e) => !e.name.startsWith('.')).map((e) => path.join(s.abs, e.name));
    if (!(await run(children, `${target}/${s.relBase}`))) return last;
  }

  return last;
}

/**
 * Catalog-based delta engine — scales to millions of files.
 *
 * Never re-lists Drive (a per-folder `list` spawn is fatal at scale) and never
 * holds the whole tree in memory. It streams the local walk, diffs each file
 * against our persisted catalog (catalog.ts), uploads only what changed in
 * bounded per-folder batches, and records the result. Drive is hit only to
 * upload (and, in mirror mode, to trash). Memory stays flat regardless of file
 * count.
 *
 *  - backup: upload new + changed; never delete; only writes the catalog for
 *    files it actually uploads, so an unchanged 4M-file run does ~no DB writes.
 *  - mirror: same, plus marks every seen file and trashes catalog entries that
 *    vanished locally (scoped to the managed source roots).
 */
export async function runCatalogDelta(
  setId: string,
  sourcePaths: string[],
  targetPath: string,
  subfolder: string,
  mode: 'backup' | 'mirror',
  excludes: string[] = [],
  log: (msg: string) => void = () => {},
  onProgress: (p: EngineProgress) => void = () => {},
  shouldCancel: () => boolean = () => false,
): Promise<DeltaResult> {
  const target = normalizeProtonPath(targetPath);
  // Each source is laid out at "<target>/<subfolder>/<source rel to LOCAL_ROOT>",
  // so same-named folders from different paths never collide and the structure is
  // preserved. The set's subfolder is the single managed root for mirror scoping.
  const sources = sourcePaths.map((abs) => ({ abs, relBase: relBaseFor(subfolder, abs) }));
  const managedRoots = new Set([subfolder]);
  // Exclude globs are authored relative to LOCAL_ROOT (no subfolder prefix), so we
  // match them against the rel with the "<subfolder>/" prefix stripped off.
  const matchExclude = makeExcluder(excludes);
  const prefix = `${subfolder}/`;
  const isExcluded = (rel: string) => matchExclude(rel.startsWith(prefix) ? rel.slice(prefix.length) : rel);
  const seenAt = Date.now();

  const cfg = getUploadConfig();
  const { workers } = resolvePlan(cfg.concurrency);
  const CHUNK = 200; // files per upload call
  const MAX_INFLIGHT = Math.max(1, workers);

  let newCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  let failedCount = 0;
  let deletedCount = 0;
  let doneFiles = 0;
  let doneBytes = 0;
  let cancelled = false;
  // Set the moment a CLI op reports the Proton session is gone. We then stop
  // scheduling work, skip the mirror deletion pass entirely, and end the run with a
  // clear "reconnect" message instead of grinding every batch through 4 doomed
  // retries (and never risking a delete pass against a half-dead session).
  let sessionDead = false;

  const speed = makeSpeedMeter();
  const report = (current: string) =>
    onProgress({ doneFiles, totalFiles: 0, doneBytes, totalBytes: 0, current, bytesPerSec: speed(doneBytes) });
  const cancelledResult = (): DeltaResult => ({
    ok: false,
    cancelled: true,
    newCount,
    changedCount,
    unchangedCount,
    deletedCount: 0,
    failedCount,
    message: `Cancelled - ${doneFiles} uploaded`,
  });

  // Fast initial seed: on the first run (empty catalog) with no excludes, let the
  // CLI recurse the whole tree in ~one process per source (`upload … -f skip`)
  // instead of tens of thousands of per-folder batch spawns, then record the
  // catalog from a local walk. Structure is preserved via uploadSourceTrees.
  // Excludes can't be honoured by the CLI recursion, so those sets fall through to
  // the per-file path below.
  if (excludes.length === 0 && catalog.count(setId) === 0) {
    log('Initial upload (recursive)…');
    report('initial upload');
    // Verbose upload so we get a per-file [metric] upload line — gives live file
    // count, bytes and speed even though the CLI does the whole tree in one go.
    let uploaded = 0;
    let lastReport = 0;
    const res = await uploadSourceTrees(sources, target, 'skip', 'merge', (bytes) => {
      uploaded += 1;
      doneFiles = uploaded;
      doneBytes += bytes;
      const now = Date.now();
      if (now - lastReport >= 250) {
        lastReport = now;
        report('uploading');
      }
    });
    if (shouldCancel()) return cancelledResult();
    if (res.code !== 0) {
      const authDead = looksUnauthenticated(res.stderr + res.stdout);
      return {
        ok: false,
        cancelled: false,
        newCount: 0,
        changedCount: 0,
        unchangedCount: 0,
        deletedCount: 0,
        failedCount: 1,
        message: authDead
          ? SESSION_EXPIRED_MSG
          : (res.stderr || res.stdout).trim().slice(0, 500) || `CLI exited with code ${res.code}`,
      };
    }

    log('Recording catalog…');
    const dirs = new Set<string>();
    let seeded = 0;
    let buf: WalkedFile[] = [];
    const flushSeed = () => {
      catalog.batch(() => {
        for (const f of buf) {
          const relDir = path.dirname(f.rel);
          if (relDir !== '.') {
            const parts = relDir.split('/');
            for (let i = 1; i <= parts.length; i++) {
              const sub = parts.slice(0, i).join('/');
              if (!dirs.has(sub)) {
                dirs.add(sub);
                catalog.upsertDir(setId, sub, seenAt);
              }
            }
          }
          catalog.upsertFile(setId, f.rel, f.size, f.mtimeMs, null, seenAt);
        }
      });
      seeded += buf.length;
      doneFiles = seeded;
      buf = [];
    };
    for (const s of sources) {
      for await (const f of walkSourceStream(s.abs, s.relBase)) {
        if (shouldCancel()) return cancelledResult();
        buf.push(f);
        if (buf.length >= 1000) {
          flushSeed();
          report('recording');
        }
      }
    }
    if (buf.length) flushSeed();
    return {
      ok: true,
      cancelled: false,
      newCount: seeded,
      changedCount: 0,
      unchangedCount: 0,
      deletedCount: 0,
      failedCount: 0,
      message: `${seeded} uploaded`,
    };
  }

  // Folders we've already ensured exist on Drive this run (dirs ≪ files).
  const ensuredDirs = new Set<string>();
  const ensureDir = async (relDir: string): Promise<void> => {
    if (relDir === '' || relDir === '.') return;
    const parts = relDir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if (ensuredDirs.has(sub)) continue;
      ensuredDirs.add(sub);
      if (catalog.hasDir(setId, sub)) continue;
      const name = parts[i - 1];
      const parentRel = parts.slice(0, i - 1).join('/');
      const parentDrive = parentRel ? `${target}/${parentRel}` : target;
      const res = await createFolder(parentDrive, name);
      // create-folder errors harmlessly if it already exists; record either way.
      void res;
      catalog.upsertDir(setId, sub, seenAt);
    }
  };

  // Bounded-concurrency flush pool.
  const inflight = new Set<Promise<void>>();
  const schedule = async (task: () => Promise<void>): Promise<void> => {
    const p = task().finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= MAX_INFLIGHT) await Promise.race(inflight);
  };

  // Upload one batch (single parent) with retry, then record it in the catalog.
  const flush = async (parentDrive: string, files: { f: WalkedFile; sha1: string | null }[]): Promise<void> => {
    if (shouldCancel() || sessionDead || files.length === 0) return;
    report(parentDrive.replace('/my-files', '') || '/');
    let ok = false;
    let lastErr = '';
    for (let attempt = 1; attempt <= 4 && !shouldCancel() && !sessionDead; attempt++) {
      const res = await upload(files.map((x) => x.f.abs), parentDrive, 'merge', 'merge');
      if (res.code === 0) {
        ok = true;
        break;
      }
      lastErr = (res.stderr || res.stdout).trim().slice(0, 200);
      // A dead session won't recover by retrying — stop now so one expired token
      // can't turn into a multi-hour zombie run holding the global run mutex.
      if (looksUnauthenticated(res.stderr + res.stdout)) {
        sessionDead = true;
        log('Proton session expired — stopping this run. Reconnect to resume.');
        return;
      }
      if (attempt < 4) {
        const waitMs = 5000 * 2 ** (attempt - 1);
        log(`  batch failed (try ${attempt}/4), retrying in ${waitMs / 1000}s: ${lastErr}`);
        for (let w = 0; w < waitMs && !shouldCancel() && !sessionDead; w += 500) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (ok) {
      catalog.batch(() => {
        for (const { f, sha1 } of files) catalog.upsertFile(setId, f.rel, f.size, f.mtimeMs, sha1, seenAt);
      });
      doneFiles += files.length;
      doneBytes += files.reduce((s, x) => s + x.f.size, 0);
    } else if (!shouldCancel() && !sessionDead) {
      failedCount += files.length;
      log(`  upload failed after 4 tries: ${lastErr}`);
    }
    report(parentDrive.replace('/my-files', '') || '/');
  };

  // Pending uploads grouped by Drive parent; flushed when a bucket fills.
  const pending = new Map<string, { f: WalkedFile; sha1: string | null }[]>();
  const queue = (parentDrive: string, item: { f: WalkedFile; sha1: string | null }) => {
    const arr = pending.get(parentDrive);
    if (arr) arr.push(item);
    else pending.set(parentDrive, [item]);
  };

  // Mirror mode marks every unchanged file as "seen this run" so the deletion pass
  // can tell what vanished locally. Doing that as one UPDATE per file means one
  // WAL commit per file — fatal for millions of unchanged files. We buffer the
  // rels and flush them in one transaction every TOUCH_FLUSH. CRITICAL: the buffer
  // MUST be drained before catalog.stale() runs, or still-buffered (unflushed)
  // files would be misread as stale and wrongly trashed. flushTouches() below is
  // called both at the threshold and right before the stale() computation.
  const TOUCH_FLUSH = 2000;
  const touchBuf: string[] = [];
  // Ancestor dirs already marked seen this run — so each is touched at most once
  // (O(#dirs), not O(#files)).
  const seenDirs = new Set<string>();
  const flushTouches = () => {
    if (touchBuf.length === 0) return;
    catalog.touchMany(setId, touchBuf, seenAt);
    touchBuf.length = 0;
  };
  // Mark a kept file as seen, plus its ancestor directory chain. Dirs only get a
  // fresh seen_at via ensureDir (i.e. for *uploaded* files), so without this a
  // no-change mirror run would leave every dir row stale and the deletion pass
  // would trash the whole subtree (down to the set folder). Touching the chain
  // keeps a dir iff it still holds at least one surviving file.
  const queueTouch = (rel: string) => {
    touchBuf.push(rel);
    let dir = path.dirname(rel);
    while (dir && dir !== '.' && !seenDirs.has(dir)) {
      seenDirs.add(dir);
      touchBuf.push(dir);
      dir = path.dirname(dir);
    }
    if (touchBuf.length >= TOUCH_FLUSH) flushTouches();
  };

  log('Comparing against catalog…');
  for (const s of sources) {
    for await (const file of walkSourceStream(s.abs, s.relBase)) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      if (sessionDead) break; // an in-flight batch reported the session is gone
      if (isExcluded(file.rel)) {
        if (mode === 'mirror') queueTouch(file.rel); // keep, don't trash
        continue;
      }

      const cat = catalog.getFile(setId, file.rel);
      const verdict = diffFile(file, cat);
      let sha1: string | null = null;
      let doUpload = verdict === 'new' || verdict === 'changed';

      if (verdict === 'hash') {
        sha1 = await sha1File(file.abs).catch(() => null);
        if (sha1 === null || !cat || sha1 !== cat.sha1) {
          doUpload = true;
        } else {
          // Same content, only mtime drifted: refresh catalog so we skip hashing
          // next time, count as unchanged, no upload.
          unchangedCount++;
          if (mode === 'mirror') queueTouch(file.rel);
          else catalog.upsertFile(setId, file.rel, file.size, file.mtimeMs, sha1, seenAt);
          continue;
        }
      }

      if (!doUpload) {
        unchangedCount++;
        if (mode === 'mirror') queueTouch(file.rel);
        continue;
      }

      if (verdict === 'new') newCount++;
      else changedCount++;

      const relDir = path.dirname(file.rel);
      await ensureDir(relDir === '.' ? '' : relDir);
      const parentDrive = relDir === '.' ? target : `${target}/${relDir}`;
      queue(parentDrive, { f: file, sha1 });

      const bucket = pending.get(parentDrive)!;
      if (bucket.length >= CHUNK) {
        pending.delete(parentDrive);
        await schedule(() => flush(parentDrive, bucket));
      }
    }
    if (cancelled || sessionDead) break;
  }

  // Flush any partially-filled buckets.
  if (!cancelled && !sessionDead) {
    for (const [parentDrive, bucket] of pending) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      if (sessionDead) break;
      await schedule(() => flush(parentDrive, bucket));
    }
  }
  await Promise.all(inflight);
  if (shouldCancel()) cancelled = true;

  // Persist any buffered "seen" marks before deciding what's stale — otherwise an
  // unflushed touch would make a present file look deleted. Safe on cancel too:
  // the deletion pass below is gated on !cancelled, so a partial flush never trashes.
  flushTouches();

  // Session died mid-run: end now with a clear reconnect message, BEFORE the mirror
  // deletion pass. Files already uploaded this run are recorded in the catalog
  // (per-batch), so a reconnect + re-run just resumes the remainder. Crucially this
  // skips stale-deletion entirely, so a half-dead session can never trash Drive.
  if (sessionDead) {
    return {
      ok: false,
      cancelled: false,
      newCount,
      changedCount,
      unchangedCount,
      deletedCount: 0,
      failedCount,
      message: SESSION_EXPIRED_MSG,
    };
  }

  // Mirror: trash catalog entries that no longer exist locally (scoped to the set
  // folder). Three safety nets first — a vanished source mount, an upload failure,
  // or a bug must never let a scan wipe Drive data the user still has:
  //   (1) if any configured source path is missing on disk (e.g. an unmounted NAS
  //       share), skip deletion entirely — "gone locally" can't be trusted.
  //   (2) if ANY upload failed this run (a changed file that didn't make it to
  //       Drive keeps its old catalog timestamp and would look "stale"), skip
  //       deletion — we must not trash a present-but-failed file's Drive copy.
  //   (3) if a run would remove more than DELETE_SAFETY_PCT of the catalog, skip
  //       deletion and flag it rather than trash a huge swath in one go.
  let deletionSkipped: string | null = null;
  if (mode === 'mirror' && !cancelled) {
    let sourcesIntact = true;
    for (const s of sources) {
      try {
        await fsp.stat(s.abs);
      } catch {
        sourcesIntact = false;
        break;
      }
    }

    const stale = catalog.stale(setId, seenAt).filter((s) => managedRoots.has(s.rel.split('/')[0]));
    const totalEntries = catalog.count(setId);
    const pctGone = totalEntries > 0 ? stale.length / totalEntries : 0;
    const DELETE_SAFETY_PCT = 0.3;

    if (!sourcesIntact) {
      deletionSkipped = 'a source path is missing on disk (mount offline?)';
    } else if (failedCount > 0) {
      deletionSkipped = `${failedCount} file(s) failed to upload — "gone locally" can't be trusted until uploads succeed`;
    } else if (pctGone > DELETE_SAFETY_PCT) {
      deletionSkipped = `${stale.length}/${totalEntries} entries (>${Math.round(DELETE_SAFETY_PCT * 100)}%) would be removed`;
    }

    if (deletionSkipped) {
      log(`Safety: ${deletionSkipped} — deletion skipped. Re-check the source, then re-run to apply deletions.`);
    } else {
      // Only trash top-most items; trashing a folder removes its children.
      const tops = stale.filter((s) => !stale.some((o) => o !== s && s.rel.startsWith(`${o.rel}/`)));
      const removedRels: string[] = [];
      for (const s of tops) {
        if (shouldCancel() || sessionDead) break;
        const res = await trashDrive(`${target}/${s.rel}`);
        if (res.ok) {
          deletedCount++;
          removedRels.push(s.rel);
        } else if (looksUnauthenticated((res.error || '') + (res.raw || ''))) {
          // Session died mid-deletion — stop now (don't grind a doomed trash per
          // entry) and end with the clear reconnect message below.
          sessionDead = true;
          log('Proton session expired — stopping this run. Reconnect to resume.');
          break;
        } else {
          failedCount++;
        }
      }
      // Drop trashed entries (and their descendants) from the catalog.
      const gone = stale
        .filter((s) => removedRels.some((r) => s.rel === r || s.rel.startsWith(`${r}/`)))
        .map((s) => s.rel);
      if (gone.length) catalog.remove(setId, gone);
      if (tops.length) log(`Removed ${deletedCount} item(s) no longer present locally`);
    }
  }

  // Session died during the deletion pass — end with the clear reconnect message
  // (deletedCount reflects what was already trashed before it died) instead of the
  // generic summary.
  if (sessionDead) {
    return {
      ok: false,
      cancelled: false,
      newCount,
      changedCount,
      unchangedCount,
      deletedCount,
      failedCount,
      message: SESSION_EXPIRED_MSG,
    };
  }

  const parts = [`${doneFiles} uploaded`, `${unchangedCount} unchanged`];
  if (mode === 'mirror' && !cancelled && !deletionSkipped) parts.push(`${deletedCount} removed`);
  if (deletionSkipped) parts.push(`deletion skipped for safety (${deletionSkipped})`);
  if (failedCount) parts.push(`${failedCount} failed`);
  return {
    ok: failedCount === 0 && !cancelled && !deletionSkipped,
    cancelled,
    newCount,
    changedCount,
    unchangedCount,
    deletedCount,
    failedCount,
    message: cancelled ? `Cancelled - ${parts.join(', ')}` : parts.join(', '),
  };
}

export interface VerifyResult {
  ok: boolean;
  checked: number; // catalog file entries examined
  repaired: number; // entries dropped (missing/changed on Drive) → re-uploaded next run
  message: string;
}

/**
 * Reconcile the catalog against Drive truth (opt-in; this is the expensive full
 * per-folder `list` scan the catalog design otherwise avoids). Lists the set's
 * Drive subtree, then drops any catalog FILE entry that is missing on Drive or
 * whose size no longer matches — e.g. a file deleted or changed externally on
 * Drive — so the next backup re-uploads it.
 *
 * Safety: it never trashes anything on Drive (worst case it schedules a
 * re-upload), and it ABORTS without touching the catalog if a Drive listing fails
 * for any reason other than "folder not found", so a transient network/auth blip
 * can't wipe the catalog.
 */
export async function verifyCatalog(
  setId: string,
  targetPath: string,
  subfolder: string,
  log: (msg: string) => void = () => {},
  shouldCancel: () => boolean = () => false,
): Promise<VerifyResult> {
  const target = normalizeProtonPath(targetPath);

  // Map of present Drive files: rel (catalog-style "<subfolder>/…") → size (-1 = unknown).
  const present = new Map<string, number>();
  let aborted: string | null = null;

  async function recur(drivePath: string, relPrefix: string): Promise<void> {
    if (aborted || shouldCancel()) return;
    const res = await listDrive(drivePath);
    if (!res.ok) {
      // Folder genuinely gone → treat as empty. Any other failure → don't risk it.
      if (/not found|no such|not exist|does not exist|cannot be found/i.test(res.error)) return;
      aborted = res.error;
      return;
    }
    for (const e of res.data) {
      if (aborted || shouldCancel()) return;
      const rel = `${relPrefix}/${e.name}`;
      if (e.type === 'folder') await recur(`${drivePath}/${e.name}`, rel);
      else present.set(rel, e.size ?? -1);
    }
  }

  log('Scanning Drive…');
  await recur(`${target}/${subfolder}`, subfolder);
  if (shouldCancel()) return { ok: false, checked: 0, repaired: 0, message: 'Cancelled' };
  if (aborted) {
    return { ok: false, checked: 0, repaired: 0, message: `Verify aborted (Drive listing failed): ${aborted}` };
  }

  // Drop catalog file entries Drive no longer backs (missing, or size changed).
  const invalid: string[] = [];
  let checked = 0;
  catalog.eachFile(setId, (f) => {
    checked++;
    const size = present.get(f.rel);
    if (size === undefined || (size >= 0 && size !== f.size)) invalid.push(f.rel);
  });
  if (invalid.length) catalog.remove(setId, invalid);

  const message = `${checked} checked · ${invalid.length} to re-upload on next run`;
  log(message);
  return { ok: true, checked, repaired: invalid.length, message };
}
