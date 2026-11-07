import { getDb, stmt, tx } from './db';

/**
 * Per-backup-set upload catalog. This is what lets the engine scale to millions
 * of files: instead of re-listing the whole Drive target every run, we keep our
 * own record of what Drive has CONFIRMED and diff the local tree against that.
 * Drive is only contacted to upload (and, in mirror mode, to trash).
 *
 * One row per uploaded file (and per folder we created or resolved), keyed by
 * (set_id, rel). Since the SDK release a row also carries the Drive node uid, so
 * a changed file becomes a new revision of exactly that node and a mirror delete
 * trashes exactly that node — no path lookups, no name-based guessing. Rows
 * written by a CLI-era release have node_uid NULL; the engine resolves them
 * lazily the first time it needs the node and stores the uid then.
 *
 * Rows are only written after Drive confirmed the operation, so a crash between
 * Drive's confirmation and the SQLite commit leaves the row missing or stale —
 * never claiming something Drive does not have. The engine reconciles that case
 * by checking the remote node before it uploads (see engine.ts `reconcile`).
 */

export interface CatalogFile {
  size: number;
  mtimeMs: number;
  sha1: string | null;
  nodeUid?: string | null;
}

export interface CatalogEntry {
  rel: string;
  kind: 'file' | 'dir';
  nodeUid: string | null;
}

const SQL = {
  getFile: "SELECT size, mtime_ms, sha1, node_uid FROM backup_catalog WHERE set_id = ? AND rel = ? AND kind = 'file'",
  getDir: "SELECT node_uid FROM backup_catalog WHERE set_id = ? AND rel = ? AND kind = 'dir'",
  upsertFile: `INSERT INTO backup_catalog (set_id, rel, kind, size, mtime_ms, sha1, seen_at, node_uid)
       VALUES (?, ?, 'file', ?, ?, ?, ?, ?)
       ON CONFLICT(set_id, rel) DO UPDATE SET
         kind = 'file', size = excluded.size, mtime_ms = excluded.mtime_ms,
         sha1 = excluded.sha1, seen_at = excluded.seen_at,
         node_uid = COALESCE(excluded.node_uid, backup_catalog.node_uid)`,
  upsertDir: `INSERT INTO backup_catalog (set_id, rel, kind, seen_at, node_uid)
       VALUES (?, ?, 'dir', ?, ?)
       ON CONFLICT(set_id, rel) DO UPDATE SET seen_at = excluded.seen_at,
         node_uid = COALESCE(excluded.node_uid, backup_catalog.node_uid)`,
  setNodeUid: 'UPDATE backup_catalog SET node_uid = ? WHERE set_id = ? AND rel = ?',
  attachNode: `UPDATE backup_catalog SET node_uid = ?, sha1 = COALESCE(sha1, ?)
       WHERE set_id = ? AND rel = ? AND kind = ? AND node_uid IS NULL`,
  touch: 'UPDATE backup_catalog SET seen_at = ? WHERE set_id = ? AND rel = ?',
  stale: 'SELECT rel, kind, node_uid FROM backup_catalog WHERE set_id = ? AND seen_at < ? ORDER BY length(rel)',
  removeOne: 'DELETE FROM backup_catalog WHERE set_id = ? AND rel = ?',
  clear: 'DELETE FROM backup_catalog WHERE set_id = ?',
  count: 'SELECT COUNT(*) AS n FROM backup_catalog WHERE set_id = ?',
  countFiles: "SELECT COUNT(*) AS n FROM backup_catalog WHERE set_id = ? AND kind = 'file'",
  maxSeenAt: 'SELECT MAX(seen_at) AS t FROM backup_catalog WHERE set_id = ?',
  eachFile: "SELECT rel, size, sha1, mtime_ms, node_uid FROM backup_catalog WHERE set_id = ? AND kind = 'file'",
  eachEntry: 'SELECT rel, kind, node_uid FROM backup_catalog WHERE set_id = ?',
  dirs: "SELECT rel, node_uid FROM backup_catalog WHERE set_id = ? AND kind = 'dir' ORDER BY rel",
  // Direct children of a folder via the expression index idx_catalog_parent
  // (rtrim(rel, replace(rel,'/','')) is rel up to and including its last '/').
  children:
    "SELECT rel, kind, size, mtime_ms, sha1, node_uid FROM backup_catalog WHERE set_id = ? AND rtrim(rel, replace(rel, '/', '')) = ?",
  childNames: "SELECT rel, kind, node_uid FROM backup_catalog WHERE set_id = ? AND rtrim(rel, replace(rel, '/', '')) = ?",
  removeTree: 'DELETE FROM backup_catalog WHERE set_id = ? AND (rel = ? OR (rel > ? AND rel < ?))',
  removePartsTree: 'DELETE FROM drive_parts WHERE set_id = ? AND (rel = ? OR (rel > ? AND rel < ?))',
  parts: 'SELECT part, node_uid FROM drive_parts WHERE set_id = ? AND rel = ? ORDER BY part',
  addPart: 'INSERT OR REPLACE INTO drive_parts (set_id, rel, part, node_uid) VALUES (?, ?, ?, ?)',
  partOwner: 'SELECT rel, part FROM drive_parts WHERE set_id = ? AND node_uid = ?',
  clearParts: 'DELETE FROM drive_parts WHERE set_id = ?',
  isListed: 'SELECT 1 FROM listed_dirs WHERE set_id = ? AND rel = ?',
  markListed: 'INSERT OR REPLACE INTO listed_dirs (set_id, rel, listed_at) VALUES (?, ?, ?)',
  removeListedTree: 'DELETE FROM listed_dirs WHERE set_id = ? AND (rel = ? OR (rel > ? AND rel < ?))',
  clearListed: 'DELETE FROM listed_dirs WHERE set_id = ?',
  listedSummary: `SELECT set_id AS setId, count(*) AS count, max(listed_at) AS lastAt,
    (SELECT rel FROM listed_dirs l2 WHERE l2.set_id = l.set_id ORDER BY listed_at DESC LIMIT 1) AS lastRel
    FROM listed_dirs l GROUP BY set_id`,
  anyBelow: 'SELECT 1 FROM backup_catalog WHERE set_id = ? AND rel > ? AND rel < ? LIMIT 1',
} as const;

// The catalog table is part of the base schema (db.ts); make sure it exists.
const ensure = () => getDb();

export const catalog = {
  getFile(setId: string, rel: string): CatalogFile | undefined {
    ensure();
    const r = stmt(SQL.getFile).get(setId, rel) as
      | { size: number; mtime_ms: number; sha1: string | null; node_uid: string | null }
      | undefined;
    return r ? { size: r.size, mtimeMs: r.mtime_ms, sha1: r.sha1, nodeUid: r.node_uid } : undefined;
  },

  /** The dir row (undefined if we never recorded this folder). */
  getDir(setId: string, rel: string): { nodeUid: string | null } | undefined {
    ensure();
    const r = stmt(SQL.getDir).get(setId, rel) as { node_uid: string | null } | undefined;
    return r ? { nodeUid: r.node_uid } : undefined;
  },

  hasDir(setId: string, rel: string): boolean {
    return catalog.getDir(setId, rel) !== undefined;
  },

  upsertFile(
    setId: string,
    rel: string,
    size: number,
    mtimeMs: number,
    sha1: string | null,
    seenAt: number,
    nodeUid: string | null = null,
  ): void {
    ensure();
    stmt(SQL.upsertFile).run(setId, rel, size, Math.round(mtimeMs), sha1, seenAt, nodeUid);
  },

  upsertDir(setId: string, rel: string, seenAt: number, nodeUid: string | null = null): void {
    ensure();
    stmt(SQL.upsertDir).run(setId, rel, seenAt, nodeUid);
  },

  /**
   * A listing found the Drive node of a row that has none (CLI-era rows): remember
   * it (and Drive's digest if we have none), so no later lookup has to list again.
   */
  attachNode(setId: string, rel: string, kind: 'file' | 'dir', nodeUid: string, sha1: string | null): void {
    ensure();
    stmt(SQL.attachNode).run(nodeUid, sha1, setId, rel, kind);
  },

  setNodeUid(setId: string, rel: string, nodeUid: string | null): void {
    ensure();
    stmt(SQL.setNodeUid).run(nodeUid, setId, rel);
  },

  /**
   * Mark many rows as seen this run, in a single transaction. The hot path for a
   * mirror backup of a mostly-unchanged tree: instead of one autocommit (and one
   * WAL frame) per file, the whole batch commits once. Callers MUST flush all
   * pending touches before stale() runs, or unflushed files would look stale.
   */
  touchMany(setId: string, rels: string[], seenAt: number): void {
    ensure();
    const s = stmt(SQL.touch);
    tx(() => {
      for (const r of rels) s.run(seenAt, setId, r);
    });
  },

  /** Rows not seen this run = present in the catalog but gone locally. */
  stale(setId: string, before: number): CatalogEntry[] {
    ensure();
    return (stmt(SQL.stale).all(setId, before) as { rel: string; kind: 'file' | 'dir'; node_uid: string | null }[]).map(
      (r) => ({ rel: r.rel, kind: r.kind, nodeUid: r.node_uid }),
    );
  },

  remove(setId: string, rels: string[]): void {
    ensure();
    const s = stmt(SQL.removeOne);
    tx(() => {
      for (const r of rels) s.run(setId, r);
    });
  },

  clear(setId: string): void {
    ensure();
    stmt(SQL.clear).run(setId);
    stmt(SQL.clearParts).run(setId);
    stmt(SQL.clearListed).run(setId);
  },

  count(setId: string): number {
    ensure();
    return (stmt(SQL.count).get(setId) as { n: number }).n;
  },

  countFiles(setId: string): number {
    ensure();
    return (stmt(SQL.countFiles).get(setId) as { n: number }).n;
  },

  /** Newest seen_at recorded for the set (0 if the catalog is empty). */
  maxSeenAt(setId: string): number {
    ensure();
    return (stmt(SQL.maxSeenAt).get(setId) as { t: number | null }).t ?? 0;
  },

  /** Stream every file entry — bounded memory for huge sets. */
  eachFile(
    setId: string,
    cb: (f: { rel: string; size: number; sha1: string | null; mtimeMs: number; nodeUid: string | null }) => void,
  ): void {
    ensure();
    // A dedicated statement per iteration: an open iterator must not share its
    // statement with a nested call.
    const it = getDb().prepare(SQL.eachFile).iterate(setId) as IterableIterator<{
      rel: string;
      size: number;
      sha1: string | null;
      mtime_ms: number;
      node_uid: string | null;
    }>;
    for (const r of it) cb({ rel: r.rel, size: r.size, sha1: r.sha1, mtimeMs: r.mtime_ms, nodeUid: r.node_uid });
  },

  /**
   * Stream every entry (files AND dirs), awaiting an async callback per row. Rows
   * are read in pages so no iterator stays open across an await (node:sqlite
   * iterators must not interleave with writes on the same connection).
   */
  async eachEntryAsync(setId: string, cb: (e: CatalogEntry) => Promise<void>): Promise<void> {
    ensure();
    const page = getDb().prepare(
      'SELECT rel, kind, node_uid FROM backup_catalog WHERE set_id = ? AND rel > ? ORDER BY rel LIMIT 1000',
    );
    let after = '';
    for (;;) {
      const rows = page.all(setId, after) as { rel: string; kind: 'file' | 'dir'; node_uid: string | null }[];
      if (rows.length === 0) return;
      for (const r of rows) await cb({ rel: r.rel, kind: r.kind, nodeUid: r.node_uid });
      after = rows[rows.length - 1].rel;
    }
  },

  /** All dir rows in rel order (dirs ≪ files). */
  dirs(setId: string): { rel: string; nodeUid: string | null }[] {
    ensure();
    return (stmt(SQL.dirs).all(setId) as { rel: string; node_uid: string | null }[]).map((r) => ({
      rel: r.rel,
      nodeUid: r.node_uid,
    }));
  },

  /** Direct children of `dirRel` (files and dirs), via the parent index. */
  children(
    setId: string,
    dirRel: string,
  ): { rel: string; kind: 'file' | 'dir'; size: number | null; mtimeMs: number | null; sha1: string | null; nodeUid: string | null }[] {
    ensure();
    return (
      stmt(SQL.children).all(setId, dirRel + '/') as {
        rel: string;
        kind: 'file' | 'dir';
        size: number | null;
        mtime_ms: number | null;
        sha1: string | null;
        node_uid: string | null;
      }[]
    ).map((r) => ({ rel: r.rel, kind: r.kind, size: r.size, mtimeMs: r.mtime_ms, sha1: r.sha1, nodeUid: r.node_uid }));
  },

  /** Direct children, minimal columns (hot path of the per-folder removal diff). */
  childNames(setId: string, dirRel: string): { rel: string; kind: 'file' | 'dir'; node_uid: string | null }[] {
    ensure();
    return stmt(SQL.childNames).all(setId, dirRel + '/') as { rel: string; kind: 'file' | 'dir'; node_uid: string | null }[];
  },

  /** Remove an entry and everything below it (range delete on the primary key). */
  removeTree(setId: string, rel: string): void {
    ensure();
    stmt(SQL.removeTree).run(setId, rel, rel + '/', rel + '0');
    stmt(SQL.removePartsTree).run(setId, rel, rel + '/', rel + '0');
    stmt(SQL.removeListedTree).run(setId, rel, rel + '/', rel + '0');
  },

  /** Was this folder's Drive content fully listed (and matching files adopted) once? */
  isListed(setId: string, rel: string): boolean {
    ensure();
    return !!stmt(SQL.isListed).get(setId, rel);
  },

  /** Per set: how many folders were fully listed, and the latest one (diagnostics). */
  listedSummary(): { setId: string; count: number; lastAt: number; lastRel: string }[] {
    ensure();
    return stmt(SQL.listedSummary).all() as { setId: string; count: number; lastAt: number; lastRel: string }[];
  },

  markListed(setId: string, rel: string): void {
    ensure();
    stmt(SQL.markListed).run(setId, rel, Date.now());
  },

  /**
   * Continuation folders of local folder `rel` (part >= 2), in order. Used when a
   * local folder holds more items than Proton allows in one Drive folder.
   */
  parts(setId: string, rel: string): { part: number; nodeUid: string }[] {
    ensure();
    return (stmt(SQL.parts).all(setId, rel) as { part: number; node_uid: string }[]).map((r) => ({ part: r.part, nodeUid: r.node_uid }));
  },

  addPart(setId: string, rel: string, part: number, nodeUid: string): void {
    ensure();
    stmt(SQL.addPart).run(setId, rel, part, nodeUid);
  },

  /** Which local folder a Drive node is a continuation folder of, if any. */
  partOwner(setId: string, nodeUid: string): { rel: string; part: number } | null {
    ensure();
    return (stmt(SQL.partOwner).get(setId, nodeUid) as { rel: string; part: number } | undefined) ?? null;
  },

  /** Whether anything is recorded strictly below `dirRel/`. */
  hasEntriesBelow(setId: string, dirRel: string): boolean {
    ensure();
    return !!stmt(SQL.anyBelow).get(setId, dirRel + '/', dirRel + '0');
  },

  /** Run a batch of writes in a single transaction (big speed-up at scale). */
  batch(fn: () => void): void {
    tx(fn);
  },
};

/**
 * Decide whether a local file needs (re)uploading, given its catalog entry.
 * Pure + side-effect-free so it can be unit-tested without a DB or Drive.
 *  - no catalog entry            -> 'new'
 *  - size differs                -> 'changed'
 *  - size same, mtime within 2s  -> 'unchanged' (no hashing)
 *  - size same, mtime drifted    -> 'hash' (caller computes sha1 and re-checks)
 *
 * The 2 s tolerance exists because some filesystems (FAT/SMB) store mtimes at
 * 2 s resolution. Consequence, documented in the README: a file whose content
 * changed while size AND mtime stayed the same is NOT detected by the fast delta
 * run — only by a content Verify, which compares SHA-1 against Drive.
 */
export type DiffVerdict = 'new' | 'changed' | 'unchanged' | 'hash';

export function diffFile(local: { size: number; mtimeMs: number }, cat: CatalogFile | undefined): DiffVerdict {
  if (!cat) return 'new';
  if (cat.size !== local.size) return 'changed';
  if (Math.abs(local.mtimeMs - cat.mtimeMs) <= 2000) return 'unchanged';
  return 'hash';
}
