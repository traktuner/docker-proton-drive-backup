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

export interface CatalogFile {
  size: number;
  mtimeMs: number;
  sha1: string | null;
}

export const catalog = {
  getFile(setId: string, rel: string): CatalogFile | undefined {
    const r = db()
      .prepare("SELECT size, mtime_ms, sha1 FROM backup_catalog WHERE set_id = ? AND rel = ? AND kind = 'file'")
      .get(setId, rel) as { size: number; mtime_ms: number; sha1: string | null } | undefined;
    return r ? { size: r.size, mtimeMs: r.mtime_ms, sha1: r.sha1 } : undefined;
  },

  hasDir(setId: string, rel: string): boolean {
    return !!db()
      .prepare("SELECT 1 FROM backup_catalog WHERE set_id = ? AND rel = ? AND kind = 'dir'")
      .get(setId, rel);
  },

  upsertFile(setId: string, rel: string, size: number, mtimeMs: number, sha1: string | null, seenAt: number): void {
    db()
      .prepare(
        `INSERT INTO backup_catalog (set_id, rel, kind, size, mtime_ms, sha1, seen_at)
         VALUES (?, ?, 'file', ?, ?, ?, ?)
         ON CONFLICT(set_id, rel) DO UPDATE SET
           kind = 'file', size = excluded.size, mtime_ms = excluded.mtime_ms,
           sha1 = excluded.sha1, seen_at = excluded.seen_at`,
      )
      .run(setId, rel, size, mtimeMs, sha1, seenAt);
  },

  upsertDir(setId: string, rel: string, seenAt: number): void {
    db()
      .prepare(
        `INSERT INTO backup_catalog (set_id, rel, kind, seen_at)
         VALUES (?, ?, 'dir', ?)
         ON CONFLICT(set_id, rel) DO UPDATE SET seen_at = excluded.seen_at`,
      )
      .run(setId, rel, seenAt);
  },

  /** Mark an existing row as seen this run (used for mirror deletion detection). */
  touch(setId: string, rel: string, seenAt: number): void {
    db().prepare('UPDATE backup_catalog SET seen_at = ? WHERE set_id = ? AND rel = ?').run(seenAt, setId, rel);
  },

  /** Rows not seen this run = present in the catalog but gone locally. */
  stale(setId: string, before: number): { rel: string; kind: string }[] {
    return db()
      .prepare('SELECT rel, kind FROM backup_catalog WHERE set_id = ? AND seen_at < ? ORDER BY length(rel)')
      .all(setId, before) as { rel: string; kind: string }[];
  },

  remove(setId: string, rels: string[]): void {
    const stmt = db().prepare('DELETE FROM backup_catalog WHERE set_id = ? AND rel = ?');
    db().transaction((rs: string[]) => {
      for (const r of rs) stmt.run(setId, r);
    })(rels);
  },

  clear(setId: string): void {
    db().prepare('DELETE FROM backup_catalog WHERE set_id = ?').run(setId);
  },

  count(setId: string): number {
    return (db().prepare('SELECT COUNT(*) AS n FROM backup_catalog WHERE set_id = ?').get(setId) as { n: number })
      .n;
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
