import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'node:path';
import fs from 'node:fs';
import { sanitizeSegment, LOCAL_ROOT } from './local';

const DB_PATH = process.env.DB_PATH || '/data/backup.db';

/** Backup mode - see runner.ts / engine.ts for behaviour. */
export type BackupMode = 'add' | 'backup' | 'mirror';

/** Schedule cadence. 'off' = manual only. */
export type Schedule = 'off' | 'hourly' | 'daily' | 'weekly';

export interface BackupSet {
  id: string;
  name: string;
  sourcePaths: string[]; // absolute in-container paths
  targetPath: string; // Proton path, '/' = drive root
  /**
   * Stable top-level Drive folder for this set, under targetPath. Snapshotted from
   * the set name at creation (sanitised, unique per target) so files land at
   * `<targetPath>/<targetSubfolder>/<source-rel-to-LOCAL_ROOT>/…`. Kept stable on
   * rename so the catalog keys (and thus uploads) don't churn.
   */
  targetSubfolder: string;
  mode: BackupMode;
  schedule: Schedule;
  scheduleHour: number; // 0-23, for daily/weekly
  scheduleMinute: number; // 0-59
  scheduleDow: number; // 0=Sun..6=Sat, for weekly
  excludes: string[]; // glob patterns to skip (backup/mirror modes)
  /** Skip generating Drive thumbnails for uploaded files (CLI `-t`). Faster, no previews. */
  skipThumbnails: boolean;
  /** Include hidden dotfiles/dotfolders in the backup (default off — they're skipped). */
  includeHidden: boolean;
  /** Auto-run on local file changes (debounced) instead of only on schedule. */
  watch: boolean;
  lastRunAt: number | null;
  lastStatus: 'never' | 'running' | 'success' | 'error' | 'cancelled' | 'paused';
  lastMessage: string | null;
  createdAt: number;
}

interface Row {
  id: string;
  name: string;
  source_paths: string;
  target_path: string;
  target_subfolder: string | null;
  mode: string; // may hold a legacy value (e.g. 'overwrite') until migrated
  schedule: Schedule;
  schedule_hour: number;
  schedule_minute: number;
  schedule_dow: number;
  excludes: string | null;
  ping_url: string | null;
  skip_thumbnails: number | null;
  include_hidden: number | null;
  watch: number | null;
  last_run_at: number | null;
  last_status: BackupSet['lastStatus'];
  last_message: string | null;
  created_at: number;
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  // WAL + NORMAL is the recommended high-throughput, crash-safe combo: no fsync
  // per commit (the dominant cost when writing the catalog for millions of files),
  // and still no corruption — at most the last transaction is lost on an OS/power
  // crash, which the next backup run self-heals (the catalog only records what we
  // uploaded). The other pragmas keep temp data and the page cache in memory and
  // let SQLite mmap the DB, all of which speed up the per-file point lookups.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536'); // ~64 MB page cache (negative = KiB)
  db.pragma('mmap_size = 268435456'); // 256 MB
  db.pragma('wal_autocheckpoint = 2000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_sets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_paths TEXT NOT NULL DEFAULT '[]',
      target_path TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'add',
      schedule TEXT NOT NULL DEFAULT 'off',
      schedule_hour INTEGER NOT NULL DEFAULT 3,
      schedule_minute INTEGER NOT NULL DEFAULT 0,
      schedule_dow INTEGER NOT NULL DEFAULT 1,
      excludes TEXT,
      ping_url TEXT,
      last_run_at INTEGER,
      last_status TEXT NOT NULL DEFAULT 'never',
      last_message TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  ensureColumns(db);
  _db = db;
  return db;
}

/** Add any columns missing from an older DB (simple forward migration). */
function ensureColumns(db: Database.Database) {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(backup_sets)').all() as { name: string }[]).map((c) => c.name),
  );
  const add = (name: string, ddl: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE backup_sets ADD COLUMN ${ddl}`);
  };
  add('mode', "mode TEXT NOT NULL DEFAULT 'add'");
  add('schedule', "schedule TEXT NOT NULL DEFAULT 'off'");
  add('schedule_hour', 'schedule_hour INTEGER NOT NULL DEFAULT 3');
  add('schedule_minute', 'schedule_minute INTEGER NOT NULL DEFAULT 0');
  add('schedule_dow', 'schedule_dow INTEGER NOT NULL DEFAULT 1');
  add('excludes', 'excludes TEXT');
  add('ping_url', 'ping_url TEXT');
  add('target_subfolder', 'target_subfolder TEXT');
  add('skip_thumbnails', 'skip_thumbnails INTEGER NOT NULL DEFAULT 0');
  add('include_hidden', 'include_hidden INTEGER NOT NULL DEFAULT 0');
  add('watch', 'watch INTEGER NOT NULL DEFAULT 0');
}

function rowToSet(r: Row): BackupSet {
  return {
    id: r.id,
    name: r.name,
    sourcePaths: JSON.parse(r.source_paths || '[]'),
    targetPath: r.target_path,
    targetSubfolder: r.target_subfolder || sanitizeSegment(r.name),
    // migrate legacy 'overwrite' → 'backup' (smarter, delta-based)
    mode: r.mode === 'backup' || r.mode === 'mirror' ? r.mode : r.mode === 'overwrite' ? 'backup' : 'add',
    schedule: r.schedule ?? 'off',
    scheduleHour: r.schedule_hour ?? 3,
    scheduleMinute: r.schedule_minute ?? 0,
    scheduleDow: r.schedule_dow ?? 1,
    excludes: JSON.parse(r.excludes || '[]'),
    skipThumbnails: !!r.skip_thumbnails,
    includeHidden: !!r.include_hidden,
    watch: !!r.watch,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastMessage: r.last_message,
    createdAt: r.created_at,
  };
}

export interface CreateBackupSet {
  name: string;
  sourcePaths: string[];
  targetPath: string;
  /** Explicit Drive subfolder; if omitted, derived from name (unique per target). */
  targetSubfolder?: string;
  mode?: BackupMode;
  schedule?: Schedule;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleDow?: number;
  excludes?: string[];
  skipThumbnails?: boolean;
  includeHidden?: boolean;
  watch?: boolean;
}

export const backupSets = {
  all(): BackupSet[] {
    return (
      getDb().prepare('SELECT * FROM backup_sets ORDER BY created_at DESC').all() as Row[]
    ).map(rowToSet);
  },

  get(id: string): BackupSet | null {
    const row = getDb().prepare('SELECT * FROM backup_sets WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToSet(row) : null;
  },

  /**
   * A Drive subfolder name that doesn't clash with another set pointing at the
   * same targetPath. Starts from `desired` (already sanitised), then appends
   * -2/-3/… until free, so two sets sharing a target never write into the same
   * top-level folder.
   */
  uniqueSubfolder(desired: string, targetPath: string): string {
    const taken = new Set(
      this.all()
        .filter((s) => s.targetPath === targetPath)
        .map((s) => s.targetSubfolder),
    );
    if (!taken.has(desired)) return desired;
    for (let i = 2; ; i++) {
      const candidate = `${desired}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  },

  create(input: CreateBackupSet): BackupSet {
    const id = nanoid(12);
    const subfolder = this.uniqueSubfolder(
      sanitizeSegment(input.targetSubfolder || input.name),
      input.targetPath,
    );
    getDb()
      .prepare(
        `INSERT INTO backup_sets
           (id, name, source_paths, target_path, target_subfolder, mode, schedule, schedule_hour, schedule_minute, schedule_dow, excludes, skip_thumbnails, include_hidden, watch, last_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.sourcePaths),
        input.targetPath,
        subfolder,
        input.mode ?? 'add',
        input.schedule ?? 'off',
        input.scheduleHour ?? 3,
        input.scheduleMinute ?? 0,
        input.scheduleDow ?? 1,
        JSON.stringify(input.excludes ?? []),
        input.skipThumbnails ? 1 : 0,
        input.includeHidden ? 1 : 0,
        input.watch ? 1 : 0,
        Date.now(),
      );
    return this.get(id)!;
  },

  update(id: string, patch: Partial<CreateBackupSet>): BackupSet | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name,
      sourcePaths: patch.sourcePaths ?? cur.sourcePaths,
      targetPath: patch.targetPath ?? cur.targetPath,
      mode: patch.mode ?? cur.mode,
      schedule: patch.schedule ?? cur.schedule,
      scheduleHour: patch.scheduleHour ?? cur.scheduleHour,
      scheduleMinute: patch.scheduleMinute ?? cur.scheduleMinute,
      scheduleDow: patch.scheduleDow ?? cur.scheduleDow,
      excludes: patch.excludes ?? cur.excludes,
      skipThumbnails: patch.skipThumbnails ?? cur.skipThumbnails,
      includeHidden: patch.includeHidden ?? cur.includeHidden,
      watch: patch.watch ?? cur.watch,
    };
    getDb()
      .prepare(
        `UPDATE backup_sets SET
           name = ?, source_paths = ?, target_path = ?, mode = ?,
           schedule = ?, schedule_hour = ?, schedule_minute = ?, schedule_dow = ?, excludes = ?,
           skip_thumbnails = ?, include_hidden = ?, watch = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        JSON.stringify(next.sourcePaths),
        next.targetPath,
        next.mode,
        next.schedule,
        next.scheduleHour,
        next.scheduleMinute,
        next.scheduleDow,
        JSON.stringify(next.excludes),
        next.skipThumbnails ? 1 : 0,
        next.includeHidden ? 1 : 0,
        next.watch ? 1 : 0,
        id,
      );
    return this.get(id);
  },

  /**
   * Append source roots while the set is stopped.
   *
   * This updates source_paths and optional selection-derived excludes in one SQL
   * statement. It deliberately does not touch backup_catalog: existing rel keys
   * remain valid, so the next delta run uploads only files from the new roots.
   */
  appendSourcesIfStopped(id: string, additions: string[], additionalExcludes: string[] = []): BackupSet | null {
    const cur = this.get(id);
    if (!cur || cur.lastStatus === 'running') return null;
    const sourcePaths = [...cur.sourcePaths, ...additions];
    const excludes = [...new Set([...cur.excludes, ...additionalExcludes])];
    const result = getDb()
      .prepare(
        `UPDATE backup_sets
         SET source_paths = ?, excludes = ?
         WHERE id = ? AND COALESCE(last_status, 'never') <> 'running'`,
      )
      .run(JSON.stringify(sourcePaths), JSON.stringify(excludes), id);
    return result.changes === 1 ? this.get(id) : null;
  },

  /**
   * Atomically rename a set's Drive subfolder in OUR records after the real Drive
   * folder rename (CLI) has succeeded: rewrite every catalog rel from the old
   * top-level prefix to the new one (the bare "<old>" dir row and all "<old>/…"
   * rows) and set target_subfolder — both in one transaction, so the next run sees
   * the new keys and re-uploads nothing. LIKE metacharacters in the old name are
   * escaped so a subfolder containing % or _ can't widen the match.
   */
  renameSubfolder(id: string, oldSub: string, newSub: string): void {
    const db = getDb();
    const likePattern = oldSub.replace(/[\\%_]/g, '\\$&') + '/%';
    db.transaction(() => {
      db.prepare(
        `UPDATE backup_catalog SET rel = ? || substr(rel, ?)
         WHERE set_id = ? AND (rel = ? OR rel LIKE ? ESCAPE '\\')`,
      ).run(newSub, oldSub.length + 1, id, oldSub, likePattern);
      db.prepare('UPDATE backup_sets SET target_subfolder = ? WHERE id = ?').run(newSub, id);
    })();
  },

  delete(id: string): void {
    getDb().prepare('DELETE FROM backup_sets WHERE id = ?').run(id);
  },

  updateStatus(
    id: string,
    status: BackupSet['lastStatus'],
    message: string | null,
    ran = false,
  ): void {
    getDb()
      .prepare(
        `UPDATE backup_sets
         SET last_status = ?, last_message = ?, last_run_at = COALESCE(?, last_run_at)
         WHERE id = ?`,
      )
      .run(status, message, ran ? Date.now() : null, id);
  },

  /**
   * Mark a set whose process died mid-run (still 'running' after a restart) as
   * interrupted, and clear its last_run_at so the scheduler treats the current
   * occurrence as not-yet-attempted and resumes it on the next tick.
   */
  markInterrupted(id: string): void {
    getDb()
      .prepare(
        `UPDATE backup_sets
         SET last_status = 'cancelled', last_message = 'Interrupted by a restart', last_run_at = NULL
         WHERE id = ?`,
      )
      .run(id);
  },
};

/**
 * One-time recovery for sets whose source paths got doubled (e.g.
 * "/sources/sources/Photos") by an older edit that re-resolved an already-absolute
 * path under LOCAL_ROOT. Peels the redundant leading LOCAL_ROOT copies, but ONLY
 * rewrites a path when the de-doubled version actually exists on disk AND the stored
 * one does not — so a real folder literally named like LOCAL_ROOT is never touched,
 * and an offline mount (where nothing exists) is left untouched. Idempotent and safe
 * to run on every startup. Does NOT touch the catalog (a later run re-seeds it).
 */
export function healDoubledSourcePaths(): void {
  const dbl = LOCAL_ROOT + LOCAL_ROOT; // e.g. "/sources" + "/sources" = "/sources/sources"
  for (const s of backupSets.all()) {
    let changed = false;
    const fixed = s.sourcePaths.map((p) => {
      let cur = p;
      while (cur === dbl || cur.startsWith(dbl + '/')) cur = cur.slice(LOCAL_ROOT.length);
      if (cur !== p && fs.existsSync(cur) && !fs.existsSync(p)) {
        changed = true;
        return cur;
      }
      return p;
    });
    if (changed) {
      getDb().prepare('UPDATE backup_sets SET source_paths = ? WHERE id = ?').run(JSON.stringify(fixed), s.id);
      console.log(`[heal] fixed doubled source path(s) for backup set "${s.name}" → ${JSON.stringify(fixed)}`);
    }
  }
}
