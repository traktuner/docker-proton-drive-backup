import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { walkSource, walkSourceStream, type WalkedFile } from './local';
import { catalog, diffFile } from './catalog';
import { getUploadConfig, resolvePlan } from './upload-config';
import {
  listDrive,
  createFolder,
  upload,
  trashDrive,
  normalizeProtonPath,
  type DriveEntry,
} from './cli';

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

interface DriveNode {
  rel: string;
  type: 'file' | 'folder';
  drivePath: string;
  size?: number;
  mtimeMs?: number;
  sha1?: string;
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

/** Recursively map the Drive target subtree: rel (relative to target) -> node. */
async function listDriveSubtree(
  targetDrivePath: string,
  shouldCancel: () => boolean = () => false,
): Promise<Map<string, DriveNode>> {
  const map = new Map<string, DriveNode>();
  const root = normalizeProtonPath(targetDrivePath);

  async function recur(drivePath: string, relPrefix: string) {
    if (shouldCancel()) return; // stop descending; runDelta returns cancelled after
    const res = await listDrive(drivePath);
    if (!res.ok) {
      // Non-existent subfolder on first run → nothing to compare; ignore.
      if (/not found|no such|not exist/i.test(res.error)) return;
      throw new Error(res.error);
    }
    for (const e of res.data as DriveEntry[]) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      const childPath = `${drivePath}/${e.name}`;
      map.set(rel, {
        rel,
        type: e.type,
        drivePath: childPath,
        size: e.size,
        mtimeMs: e.mtimeMs,
        sha1: e.sha1,
      });
      if (e.type === 'folder') await recur(childPath, rel);
    }
  }

  await recur(root, '');
  return map;
}

async function isChanged(local: WalkedFile, drive: DriveNode): Promise<boolean> {
  if (drive.size !== local.size) return true;
  // Same size + mtime (±2s) → treat as unchanged without hashing.
  if (drive.mtimeMs != null && Math.abs(local.mtimeMs - drive.mtimeMs) <= 2000) return false;
  // Size matches but mtime drifted: hash to avoid a needless re-upload.
  if (!drive.sha1) return true;
  try {
    return (await sha1File(local.abs)) !== drive.sha1;
  } catch {
    return true; // unreadable → attempt re-upload
  }
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

export async function runDelta(
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
  const cancelledResult = (): DeltaResult => ({
    ok: false,
    cancelled: true,
    newCount: 0,
    changedCount: 0,
    unchangedCount: 0,
    deletedCount: 0,
    failedCount: 0,
    message: 'Cancelled',
  });

  // 1. Local inventory (excluded paths removed). Collect element-by-element and
  // filter into a new array — never `push(...bigArray)` / spread, which blows the
  // call stack ("Maximum call stack size exceeded") past ~100k files.
  const collected: WalkedFile[] = [];
  for (const sp of sourcePaths) {
    for (const f of await walkSource(sp)) collected.push(f);
  }
  const localFiles = collected.filter((f) => !isExcluded(f.rel));
  if (collected.length !== localFiles.length) {
    log(`Excluded ${collected.length - localFiles.length} file(s) by pattern`);
  }
  const localByRel = new Map(localFiles.map((f) => [f.rel, f]));
  const managedRoots = new Set(sourcePaths.map((sp) => path.basename(sp)));

  // All directory rels implied by the local tree (for mirror folder retention).
  const localDirs = new Set<string>();
  for (const f of localFiles) {
    const parts = f.rel.split('/');
    for (let i = 1; i < parts.length; i++) localDirs.add(parts.slice(0, i).join('/'));
  }

  // 2. Drive inventory.
  log('Scanning Drive…');
  const drive = await listDriveSubtree(target, shouldCancel);
  if (shouldCancel()) return cancelledResult();

  // 3. Classify local files.
  const toUpload: WalkedFile[] = [];
  let newCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  for (const f of localFiles) {
    if (shouldCancel()) return cancelledResult();
    const d = drive.get(f.rel);
    if (!d || d.type !== 'file') {
      toUpload.push(f);
      newCount++;
    } else if (await isChanged(f, d)) {
      toUpload.push(f);
      changedCount++;
    } else {
      unchangedCount++;
    }
  }
  log(`${newCount} new, ${changedCount} changed, ${unchangedCount} unchanged`);

  // 4. Ensure parent folders exist (shallow → deep), then upload.
  let failedCount = 0;
  // Logged once if the CLI still can't `merge` files and we fell back to replace
  // (so the job log shows whether Proton's fix has landed yet for this run).
  let mergeFellBack = false;
  const parentOf = (f: WalkedFile) => {
    const relDir = path.dirname(f.rel);
    return relDir === '.' ? target : `${target}/${relDir}`;
  };

  const neededDirs = new Set<string>();
  for (const f of toUpload) {
    const parts = path.dirname(f.rel).split('/');
    if (parts[0] === '.') continue;
    for (let i = 1; i <= parts.length; i++) neededDirs.add(parts.slice(0, i).join('/'));
  }
  for (const relDir of [...neededDirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
    if (drive.has(relDir)) continue;
    const parts = relDir.split('/');
    const name = parts[parts.length - 1];
    const parentRel = parts.slice(0, -1).join('/');
    const parentDrive = parentRel ? `${target}/${parentRel}` : target;
    const res = await createFolder(parentDrive, name);
    if (res.ok) drive.set(relDir, { rel: relDir, type: 'folder', drivePath: `${target}/${relDir}` });
    // If it already exists the CLI errors harmlessly; ignore.
  }

  const totalFiles = toUpload.length;
  const totalBytes = toUpload.reduce((s, f) => s + f.size, 0);
  let doneFiles = 0;
  let doneBytes = 0;
  let cancelled = false;
  onProgress({ doneFiles, totalFiles, doneBytes, totalBytes, current: 'Starting upload…' });

  // Upload one batch (single parent folder) with backoff + cancel-awareness.
  const uploadBatch = async (parentDrive: string, files: WalkedFile[]): Promise<void> => {
    if (shouldCancel()) {
      cancelled = true;
      return;
    }
    const where = parentDrive.replace('/my-files', '') || '/';
    onProgress({ doneFiles, totalFiles, doneBytes, totalBytes, current: where });
    let ok = false;
    let lastErr = '';
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts && !shouldCancel(); attempt++) {
      // `merge` = write a new revision (preserves Drive's version history). The
      // CLI can't merge files yet and upload() transparently falls back to
      // `replace` until Proton ships the fix - at which point this becomes a true
      // revisioned update with no code change here.
      const res = await upload(
        files.map((f) => f.abs),
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
      if (attempt < maxAttempts) {
        const waitMs = 5000 * 2 ** (attempt - 1); // 5s, 10s, 20s
        log(`  batch failed (try ${attempt}/${maxAttempts}), retrying in ${waitMs / 1000}s: ${lastErr}`);
        for (let w = 0; w < waitMs && !shouldCancel(); w += 500) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (ok) {
      doneFiles += files.length;
      doneBytes += files.reduce((s, f) => s + f.size, 0);
    } else if (!shouldCancel()) {
      failedCount += files.length;
      log(`  upload failed after ${maxAttempts} tries: ${lastErr}`);
    }
    onProgress({ doneFiles, totalFiles, doneBytes, totalBytes, current: where });
  };

  // Partition by size, smallest first. Small files upload in parallel (worker
  // pool); large files strictly one-at-a-time (bandwidth-bound, avoids several
  // huge transfers at once).
  const cfg = getUploadConfig();
  const thresholdBytes = cfg.thresholdMB * 1024 * 1024;
  const { workers, streamsPerWorker } = resolvePlan(cfg.concurrency);
  const asc = (a: WalkedFile, b: WalkedFile) => a.size - b.size;
  const smallFiles = toUpload.filter((f) => f.size < thresholdBytes).sort(asc);
  const largeFiles = toUpload.filter((f) => f.size >= thresholdBytes).sort(asc);
  log(
    `${smallFiles.length} small (<${cfg.thresholdMB}MB, ${workers}×~${streamsPerWorker} parallel) + ${largeFiles.length} large (serial)`,
  );

  // Small-file jobs: group by parent, chunk so the pool stays fed and the CLI
  // runs ~streamsPerWorker streams per call (big batch when not throttling).
  const chunkSize = streamsPerWorker >= 4 ? 200 : streamsPerWorker;
  const smallByParent = new Map<string, WalkedFile[]>();
  for (const f of smallFiles) {
    const p = parentOf(f);
    if (!smallByParent.has(p)) smallByParent.set(p, []);
    smallByParent.get(p)!.push(f);
  }
  const jobs: { parent: string; files: WalkedFile[] }[] = [];
  for (const [p, files] of smallByParent) {
    for (let i = 0; i < files.length; i += chunkSize) jobs.push({ parent: p, files: files.slice(i, i + chunkSize) });
  }

  // Worker pool for small files.
  let nextJob = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, workers) }, async () => {
      while (nextJob < jobs.length && !shouldCancel()) {
        const job = jobs[nextJob++];
        await uploadBatch(job.parent, job.files);
      }
    }),
  );

  // Large files: strictly serial, one file per call.
  for (const f of largeFiles) {
    if (shouldCancel()) break;
    await uploadBatch(parentOf(f), [f]);
  }
  if (shouldCancel()) cancelled = true;

  // 5. Mirror: trash Drive items (within managed roots) with no local match.
  // Skipped if the run was cancelled - deleting on a partial upload is unsafe.
  let deletedCount = 0;
  if (mode === 'mirror' && !cancelled) {
    const toDelete: DriveNode[] = [];
    for (const node of drive.values()) {
      const top = node.rel.split('/')[0];
      if (!managedRoots.has(top)) continue; // never touch unrelated Drive content
      const existsLocally =
        node.type === 'file' ? localByRel.has(node.rel) : localDirs.has(node.rel) || managedRoots.has(node.rel);
      if (!existsLocally) toDelete.push(node);
    }
    // Only trash top-most items (trashing a folder removes its children).
    const tops = toDelete.filter(
      (n) => !toDelete.some((o) => o !== n && n.rel.startsWith(`${o.rel}/`)),
    );
    for (const n of tops) {
      const res = await trashDrive(n.drivePath);
      if (res.ok) deletedCount++;
      else failedCount++;
    }
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

/**
 * Catalog-based delta engine — scales to millions of files.
 *
 * vs runDelta(): never re-lists Drive (the per-folder `list` spawn is fatal at
 * scale) and never holds the whole tree in memory. It streams the local walk,
 * diffs each file against our persisted catalog (catalog.ts), uploads only what
 * changed in bounded per-folder batches, and records the result. Drive is hit
 * only to upload (and, in mirror mode, to trash). Memory stays flat regardless
 * of file count.
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

  log('Comparing against catalog…');
  for (const sp of sourcePaths) {
    for await (const file of walkSourceStream(sp)) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      if (isExcluded(file.rel)) {
        if (mode === 'mirror') catalog.touch(setId, file.rel, seenAt); // keep, don't trash
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
          if (mode === 'mirror') catalog.touch(setId, file.rel, seenAt);
          else catalog.upsertFile(setId, file.rel, file.size, file.mtimeMs, sha1, seenAt);
          continue;
        }
      }

      if (!doUpload) {
        unchangedCount++;
        if (mode === 'mirror') catalog.touch(setId, file.rel, seenAt);
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
