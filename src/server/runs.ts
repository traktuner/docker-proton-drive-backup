import { getDb } from './db';

/**
 * Per-set run history — the trust record of a backup tool: "did it run, when did
 * it last succeed, how has it been doing lately". One row per finished run,
 * capped to the most recent ~50 per set.
 */

let ensured = false;
function db(): ReturnType<typeof getDb> {
  const d = getDb();
  if (!ensured) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS backup_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        set_id      TEXT    NOT NULL,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        status      TEXT    NOT NULL,        -- success | error | cancelled
        message     TEXT,
        files       INTEGER NOT NULL DEFAULT 0,
        bytes       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_set ON backup_runs (set_id, started_at DESC);
    `);
    // Additive migration for existing DBs: the per-run list of skipped files
    // (JSON). Nullable so old rows read back as an empty list.
    const cols = new Set(
      (d.prepare('PRAGMA table_info(backup_runs)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!cols.has('skipped')) d.exec('ALTER TABLE backup_runs ADD COLUMN skipped TEXT');
    ensured = true;
  }
  return d;
}

export interface SkippedFile {
  rel: string;
  reason: string;
}

export interface RunRow {
  id: number;
  startedAt: number;
  finishedAt: number;
  status: 'success' | 'error' | 'cancelled';
  message: string | null;
  files: number;
  bytes: number;
  /** Files skipped this run (name unsupported / unreadable). A bounded sample. */
  skipped: SkippedFile[];
}

function parseSkipped(raw: string | null): SkippedFile[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as SkippedFile[]) : [];
  } catch {
    return [];
  }
}

export const runs = {
  record(setId: string, r: Omit<RunRow, 'id'>): void {
    const d = db();
    d.prepare(
      `INSERT INTO backup_runs (set_id, started_at, finished_at, status, message, files, bytes, skipped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(setId, r.startedAt, r.finishedAt, r.status, r.message, r.files, r.bytes, JSON.stringify(r.skipped ?? []));
    d.prepare(
      `DELETE FROM backup_runs WHERE set_id = ? AND id NOT IN (
         SELECT id FROM backup_runs WHERE set_id = ? ORDER BY started_at DESC LIMIT 50)`,
    ).run(setId, setId);
  },

  recent(setId: string, limit = 8): RunRow[] {
    const rows = db()
      .prepare(
        `SELECT id, started_at AS startedAt, finished_at AS finishedAt, status, message, files, bytes, skipped
         FROM backup_runs WHERE set_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(setId, limit) as (Omit<RunRow, 'skipped'> & { skipped: string | null })[];
    return rows.map((r) => ({ ...r, skipped: parseSkipped(r.skipped) }));
  },

  lastSuccessAt(setId: string): number | null {
    const r = db()
      .prepare(
        `SELECT finished_at AS t FROM backup_runs
         WHERE set_id = ? AND status = 'success' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(setId) as { t: number } | undefined;
    return r?.t ?? null;
  },

  clear(setId: string): void {
    db().prepare('DELETE FROM backup_runs WHERE set_id = ?').run(setId);
  },
};
