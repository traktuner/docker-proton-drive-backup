import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { walkSourceStream, type WalkedFile } from './local';
import { catalog, diffFile } from './catalog';
import { getUploadConfig, resolvePlan } from './upload-config';
import { createFolder, upload, trashDrive, normalizeProtonPath } from './cli';

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
  mode: 'backup' | 'mirror',
  excludes: string[] = [],
  log: (msg: string) => void = () => {},
  onProgress: (p: EngineProgress) => void = () => {},
  shouldCancel: () => boolean = () => false,
): Promise<DeltaResult> {
  const target = normalizeProtonPath(targetPath);
  const isExcluded = makeExcluder(excludes);
  const managedRoots = new Set(sourcePaths.map((sp) => path.basename(sp)));
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
  let mergeFellBack = false;

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
  // CLI recurse the whole tree in ONE process (`upload <dirs> -f skip`) instead of
  // tens of thousands of per-folder batch spawns, then record the catalog from a
  // local walk. Excludes can't be honoured by the CLI recursion, so those sets
  // fall through to the per-file path below.
  if (excludes.length === 0 && catalog.count(setId) === 0) {
    log('Initial upload (recursive)…');
    report('initial upload');
    // Verbose upload so we get a per-file [metric] upload line — gives live file
    // count, bytes and speed even though the CLI does the whole tree in one go.
    let uploaded = 0;
    let lastReport = 0;
    const res = await upload(sourcePaths, target, 'skip', 'merge', undefined, (bytes) => {
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
      return {
        ok: false,
        cancelled: false,
        newCount: 0,
        changedCount: 0,
        unchangedCount: 0,
        deletedCount: 0,
        failedCount: 1,
        message: (res.stderr || res.stdout).trim().slice(0, 500) || `CLI exited with code ${res.code}`,
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
    for (const sp of sourcePaths) {
      for await (const f of walkSourceStream(sp)) {
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
    if (shouldCancel() || files.length === 0) return;
    report(parentDrive.replace('/my-files', '') || '/');
    let ok = false;
    let lastErr = '';
    for (let attempt = 1; attempt <= 4 && !shouldCancel(); attempt++) {
      const res = await upload(
        files.map((x) => x.f.abs),
        parentDrive,
        'merge',
        'merge',
        () => {
          if (!mergeFellBack) {
            mergeFellBack = true;
            log('Note: CLI can’t merge files yet - using replace (no version history this run)');
          }
        },
      );
      if (res.code === 0) {
        ok = true;
        break;
      }
      lastErr = (res.stderr || res.stdout).trim().slice(0, 200);
      if (attempt < 4) {
        const waitMs = 5000 * 2 ** (attempt - 1);
        log(`  batch failed (try ${attempt}/4), retrying in ${waitMs / 1000}s: ${lastErr}`);
        for (let w = 0; w < waitMs && !shouldCancel(); w += 500) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (ok) {
      catalog.batch(() => {
        for (const { f, sha1 } of files) catalog.upsertFile(setId, f.rel, f.size, f.mtimeMs, sha1, seenAt);
      });
      doneFiles += files.length;
      doneBytes += files.reduce((s, x) => s + x.f.size, 0);
    } else if (!shouldCancel()) {
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
  const flushTouches = () => {
    if (touchBuf.length === 0) return;
    catalog.touchMany(setId, touchBuf, seenAt);
    touchBuf.length = 0;
  };
  const queueTouch = (rel: string) => {
    touchBuf.push(rel);
    if (touchBuf.length >= TOUCH_FLUSH) flushTouches();
  };

  log('Comparing against catalog…');
  for (const sp of sourcePaths) {
    for await (const file of walkSourceStream(sp)) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
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
    if (cancelled) break;
  }

  // Flush any partially-filled buckets.
  if (!cancelled) {
    for (const [parentDrive, bucket] of pending) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      await schedule(() => flush(parentDrive, bucket));
    }
  }
  await Promise.all(inflight);
  if (shouldCancel()) cancelled = true;

  // Persist any buffered "seen" marks before deciding what's stale — otherwise an
  // unflushed touch would make a present file look deleted. Safe on cancel too:
  // the deletion pass below is gated on !cancelled, so a partial flush never trashes.
  flushTouches();

  // Mirror: trash catalog entries that no longer exist locally (scoped to roots).
  if (mode === 'mirror' && !cancelled) {
    const stale = catalog.stale(setId, seenAt).filter((s) => managedRoots.has(s.rel.split('/')[0]));
    // Only trash top-most items; trashing a folder removes its children.
    const tops = stale.filter((s) => !stale.some((o) => o !== s && s.rel.startsWith(`${o.rel}/`)));
    const removedRels: string[] = [];
    for (const s of tops) {
      if (shouldCancel()) break;
      const res = await trashDrive(`${target}/${s.rel}`);
      if (res.ok) {
        deletedCount++;
        removedRels.push(s.rel);
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

  const parts = [`${doneFiles} uploaded`, `${unchangedCount} unchanged`];
  if (mode === 'mirror' && !cancelled) parts.push(`${deletedCount} removed`);
  if (failedCount) parts.push(`${failedCount} failed`);
  return {
    ok: failedCount === 0 && !cancelled,
    cancelled,
    newCount,
    changedCount,
    unchangedCount,
    deletedCount,
    failedCount,
    message: cancelled ? `Cancelled - ${parts.join(', ')}` : parts.join(', '),
  };
}
