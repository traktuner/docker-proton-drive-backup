import { getDb } from './db';

/**
 * Per-backup-set upload catalog. This is what lets the engine scale to millions
 * of files: instead of re-listing the whole Drive target every run (one CLI
 * `list` spawn PER FOLDER — fatal at scale), we keep our own record of what we
 * have uploaded and diff the local tree against THAT. Drive is only contacted to
 * upload (and, in mirror mode, to trash) — never to enumerate.
 *
 * One row per uploaded file (and per folder we created), keyed by (set_id, rel).
 * Trade-off: the catalog can drift from Drive if files are changed/deleted on
 * Drive externally. A `verify`/reconcile pass (full Drive scan) repairs it; for
 * huge sets you simply don't run that often.
 */

import type { Statement } from 'better-sqlite3';
type Stmt = Statement<unknown[]>;

/**
 * Prepared statements, compiled once for the process lifetime. better-sqlite3
 * (11.x) does NOT cache compiled statements, so calling db().prepare(...) per file
 * would re-parse the SQL millions of times in the hot diff loop. We compile each
 * statement lazily on first use — AFTER the table exists — and reuse it. getDb()
 * returns a process singleton (one connection, no reconnect), so these stay valid.
 */
let _stmts: {
  getFile: Stmt;
  hasDir: Stmt;
  upsertFile: Stmt;
  upsertDir: Stmt;
  touch: Stmt;
  stale: Stmt;
  removeOne: Stmt;
  clear: Stmt;
  count: Stmt;
  eachFile: Stmt;
  eachEntry: Stmt;
} | null = null;

let ensured = false;
function db(): ReturnType<typeof getDb> {
  const d = getDb();
  if (!ensured) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS backup_catalog (
        set_id   TEXT    NOT NULL,
        rel      TEXT    NOT NULL,
        kind     TEXT    NOT NULL,          -- 'file' | 'dir'
        size     INTEGER,
        mtime_ms INTEGER,
        sha1     TEXT,
        seen_at  INTEGER NOT NULL,
        PRIMARY KEY (set_id, rel)
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_seen ON backup_catalog (set_id, seen_at);
    `);
    ensured = true;
  }
  return d;
}

/** The compiled statements, prepared once against the (ensured) catalog table. */
function stmts() {
  if (_stmts) return _stmts;
  const d = db(); // ensures the table exists before we compile against it
  _stmts = {
    getFile: d.prepare(
      "SELECT size, mtime_ms, sha1 FROM backup_catalog WHERE set_id = ? AND rel = ? AND kind = 'file'",
    ),
    hasDir: d.prepare("SELECT 1 FROM backup_catalog WHERE set_id = ? AND rel = ? AND kind = 'dir'"),
    upsertFile: d.prepare(
      `INSERT INTO backup_catalog (set_id, rel, kind, size, mtime_ms, sha1, seen_at)
       VALUES (?, ?, 'file', ?, ?, ?, ?)
       ON CONFLICT(set_id, rel) DO UPDATE SET
         kind = 'file', size = excluded.size, mtime_ms = excluded.mtime_ms,
         sha1 = excluded.sha1, seen_at = excluded.seen_at`,
    ),
    upsertDir: d.prepare(
      `INSERT INTO backup_catalog (set_id, rel, kind, seen_at)
       VALUES (?, ?, 'dir', ?)
       ON CONFLICT(set_id, rel) DO UPDATE SET seen_at = excluded.seen_at`,
    ),
    touch: d.prepare('UPDATE backup_catalog SET seen_at = ? WHERE set_id = ? AND rel = ?'),
    stale: d.prepare(
      'SELECT rel, kind FROM backup_catalog WHERE set_id = ? AND seen_at < ? ORDER BY length(rel)',
    ),
    removeOne: d.prepare('DELETE FROM backup_catalog WHERE set_id = ? AND rel = ?'),
    clear: d.prepare('DELETE FROM backup_catalog WHERE set_id = ?'),
    count: d.prepare('SELECT COUNT(*) AS n FROM backup_catalog WHERE set_id = ?'),
    eachFile: d.prepare("SELECT rel, size, sha1 FROM backup_catalog WHERE set_id = ? AND kind = 'file'"),
    eachEntry: d.prepare('SELECT rel, kind FROM backup_catalog WHERE set_id = ?'),
  };
  return _stmts;
}

export interface CatalogFile {
  size: number;
  mtimeMs: number;
  sha1: string | null;
}

export const catalog = {
  getFile(setId: string, rel: string): CatalogFile | undefined {
    const r = stmts().getFile.get(setId, rel) as
      | { size: number; mtime_ms: number; sha1: string | null }
      | undefined;
    return r ? { size: r.size, mtimeMs: r.mtime_ms, sha1: r.sha1 } : undefined;
  },

  hasDir(setId: string, rel: string): boolean {
    return !!stmts().hasDir.get(setId, rel);
  },

  upsertFile(setId: string, rel: string, size: number, mtimeMs: number, sha1: string | null, seenAt: number): void {
    stmts().upsertFile.run(setId, rel, size, mtimeMs, sha1, seenAt);
  },

  upsertDir(setId: string, rel: string, seenAt: number): void {
    stmts().upsertDir.run(setId, rel, seenAt);
  },

  /**
   * Mark many rows as seen this run, in a single transaction. The hot path for a
   * mirror backup of a mostly-unchanged tree: instead of one autocommit (and one
   * WAL frame) per file, the whole batch commits once. Callers MUST flush all
   * pending touches before stale() runs, or unflushed files would look stale.
   */
  touchMany(setId: string, rels: string[], seenAt: number): void {
    const stmt = stmts().touch;
    db().transaction((rs: string[]) => {
      for (const r of rs) stmt.run(seenAt, setId, r);
    })(rels);
  },

  /** Rows not seen this run = present in the catalog but gone locally. */
  stale(setId: string, before: number): { rel: string; kind: string }[] {
    return stmts().stale.all(setId, before) as { rel: string; kind: string }[];
  },

  remove(setId: string, rels: string[]): void {
    const stmt = stmts().removeOne;
    db().transaction((rs: string[]) => {
      for (const r of rs) stmt.run(setId, r);
    })(rels);
  },

  clear(setId: string): void {
    stmts().clear.run(setId);
  },

  count(setId: string): number {
    return (stmts().count.get(setId) as { n: number }).n;
  },

  /** Stream every file entry (rel/size/sha1) — bounded memory for huge sets. */
  eachFile(setId: string, cb: (f: { rel: string; size: number; sha1: string | null }) => void): void {
    for (const r of stmts().eachFile.iterate(setId) as IterableIterator<{
      rel: string;
      size: number;
      sha1: string | null;
    }>) {
      cb(r);
    }
  },

  /**
   * Stream every entry (files AND dirs) as {rel, kind}, awaiting an async callback
   * per row — used by the read-only mirror preview to stat each entry on disk
   * without ever materialising the whole catalog in memory. Read-only: the caller
   * MUST NOT run other catalog statements while this iterator is open (we only
   * stat the filesystem between rows, never touch the DB).
   */
  async eachEntryAsync(setId: string, cb: (e: { rel: string; kind: string }) => Promise<void>): Promise<void> {
    for (const r of stmts().eachEntry.iterate(setId) as IterableIterator<{ rel: string; kind: string }>) {
      await cb(r);
    }
  },

  /** Run a batch of writes in a single transaction (big speed-up at scale). */
  batch(fn: () => void): void {
    db().transaction(fn)();
  },
};

/**
 * Decide whether a local file needs (re)uploading, given its catalog entry.
 * Pure + side-effect-free so it can be unit-tested without a DB or the CLI.
 *  - no catalog entry            -> 'new'
 *  - size differs                -> 'changed'
 *  - size same, mtime within 2s  -> 'unchanged' (no hashing)
 *  - size same, mtime drifted    -> 'hash' (caller computes sha1 and re-checks)
 */
export type DiffVerdict = 'new' | 'changed' | 'unchanged' | 'hash';

export function diffFile(
  local: { size: number; mtimeMs: number },
  cat: CatalogFile | undefined,
): DiffVerdict {
  if (!cat) return 'new';
  if (cat.size !== local.size) return 'changed';
  if (Math.abs(local.mtimeMs - cat.mtimeMs) <= 2000) return 'unchanged';
  return 'hash';
}
