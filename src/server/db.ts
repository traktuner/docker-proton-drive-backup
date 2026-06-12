import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'node:path';
import fs from 'node:fs';

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
  mode: BackupMode;
  schedule: Schedule;
  scheduleHour: number; // 0-23, for daily/weekly
  scheduleMinute: number; // 0-59
  scheduleDow: number; // 0=Sun..6=Sat, for weekly
  excludes: string[]; // glob patterns to skip (backup/mirror modes)
  lastRunAt: number | null;
  lastStatus: 'never' | 'running' | 'success' | 'error' | 'cancelled';
  lastMessage: string | null;
  createdAt: number;
}

interface Row {
  id: string;
  name: string;
  source_paths: string;
  target_path: string;
  mode: string; // may hold a legacy value (e.g. 'overwrite') until migrated
  schedule: Schedule;
  schedule_hour: number;
  schedule_minute: number;
  schedule_dow: number;
  excludes: string | null;
  ping_url: string | null;
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
}

function rowToSet(r: Row): BackupSet {
  return {
    id: r.id,
    name: r.name,
    sourcePaths: JSON.parse(r.source_paths || '[]'),
    targetPath: r.target_path,
    // migrate legacy 'overwrite' → 'backup' (smarter, delta-based)
    mode: r.mode === 'backup' || r.mode === 'mirror' ? r.mode : r.mode === 'overwrite' ? 'backup' : 'add',
    schedule: r.schedule ?? 'off',
    scheduleHour: r.schedule_hour ?? 3,
    scheduleMinute: r.schedule_minute ?? 0,
    scheduleDow: r.schedule_dow ?? 1,
    excludes: JSON.parse(r.excludes || '[]'),
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
  mode?: BackupMode;
  schedule?: Schedule;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleDow?: number;
  excludes?: string[];
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

  create(input: CreateBackupSet): BackupSet {
    const id = nanoid(12);
    getDb()
      .prepare(
        `INSERT INTO backup_sets
           (id, name, source_paths, target_path, mode, schedule, schedule_hour, schedule_minute, schedule_dow, excludes, last_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.sourcePaths),
        input.targetPath,
        input.mode ?? 'add',
        input.schedule ?? 'off',
        input.scheduleHour ?? 3,
        input.scheduleMinute ?? 0,
        input.scheduleDow ?? 1,
        JSON.stringify(input.excludes ?? []),
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
    };
    getDb()
      .prepare(
        `UPDATE backup_sets SET
           name = ?, source_paths = ?, target_path = ?, mode = ?,
           schedule = ?, schedule_hour = ?, schedule_minute = ?, schedule_dow = ?, excludes = ?
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
        id,
      );
    return this.get(id);
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
