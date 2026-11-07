import { DatabaseSync } from 'node:sqlite';
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
  /**
   * Drive node uid of `<targetPath>/<targetSubfolder>` as last confirmed by a run.
   * A different node at the same path (folder deleted and re-created, or a rename
   * elsewhere) is detected instead of silently writing into the wrong folder.
   */
  folderUid: string | null;
  /** Mount marks per source root from the last completed run (mirror safety). */
  sourceMarks: Record<string, SourceMark>;
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
  folder_uid: string | null;
  source_marks: string | null;
  last_run_at: number | null;
  last_status: BackupSet['lastStatus'];
  last_message: string | null;
  created_at: number;
}

let _db: DatabaseSync | null = null;

/**
 * Schema version written to `PRAGMA user_version` after a successful migration.
 *
 *  0  every CLI-era release (tables created ad hoc, columns added in place)
 *  1  SDK release: Drive node ids in the catalog, per-set Drive bindings and the
 *     app_meta key/value table. Purely ADDITIVE, so a CLI-era image can still open
 *     the same file after a rollback (it ignores columns and tables it does not
 *     know, and every one of its statements names its columns explicitly).
 */
export const SCHEMA_VERSION = 1;

/** Path of the one-time pre-migration snapshot next to the DB. */
export function preMigrationBackupPath(): string {
  return `${DB_PATH}.pre-sdk.bak`;
}

export function getDb(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH, { timeout: 5000 });
  // WAL + NORMAL is the recommended high-throughput, crash-safe combo: no fsync
  // per commit (the dominant cost when writing the catalog for millions of files),
  // and still no corruption — at most the last transaction is lost on an OS/power
  // crash, which the next run self-heals: the catalog only records what Drive has
  // confirmed, and a missing row is re-checked against Drive before any upload.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -16384;   -- 16 MiB page cache (was 64 MiB; the OS page cache does the rest)
    PRAGMA mmap_size = 268435456; -- 256 MiB, file-backed (reclaimable, not heap)
    PRAGMA wal_autocheckpoint = 2000;
    PRAGMA foreign_keys = OFF;
  `);
  createBaseSchema(db);
  migrate(db);
  _db = db;
  return db;
}

/** Close the connection (tests and graceful shutdown). */
export function closeDb(): void {
  if (_db) {
    try {
      _db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* best-effort */
    }
    _db.close();
    _db = null;
    stmtCache.clear();
  }
}

/** The CLI-era schema, created idempotently exactly as every 0.x release did. */
function createBaseSchema(db: DatabaseSync) {
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
  const add = (table: string, name: string, ddl: string) => {
    const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    if (!cols.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  add('backup_sets', 'mode', "mode TEXT NOT NULL DEFAULT 'add'");
  add('backup_sets', 'schedule', "schedule TEXT NOT NULL DEFAULT 'off'");
  add('backup_sets', 'schedule_hour', 'schedule_hour INTEGER NOT NULL DEFAULT 3');
  add('backup_sets', 'schedule_minute', 'schedule_minute INTEGER NOT NULL DEFAULT 0');
  add('backup_sets', 'schedule_dow', 'schedule_dow INTEGER NOT NULL DEFAULT 1');
  add('backup_sets', 'excludes', 'excludes TEXT');
  add('backup_sets', 'ping_url', 'ping_url TEXT');
  add('backup_sets', 'target_subfolder', 'target_subfolder TEXT');
  add('backup_sets', 'skip_thumbnails', 'skip_thumbnails INTEGER NOT NULL DEFAULT 0');
  add('backup_sets', 'include_hidden', 'include_hidden INTEGER NOT NULL DEFAULT 0');
  add('backup_sets', 'watch', 'watch INTEGER NOT NULL DEFAULT 0');
  add('backup_runs', 'skipped', 'skipped TEXT');
}

/**
 * Forward-only, additive, idempotent migration to SCHEMA_VERSION.
 *
 * Crash safety: every step runs in ONE transaction together with the
 * user_version bump, so a kill mid-migration rolls back to the old version and
 * the next start simply repeats it. Before the first migration of a DB that
 * already holds data, a consistent snapshot (`VACUUM INTO`, which includes
 * committed WAL content) is written next to the DB — once, via a temp name +
 * rename, so an interrupted snapshot is never mistaken for a complete one.
 */
function migrate(db: DatabaseSync) {
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (v >= SCHEMA_VERSION) return;
  const hasData = (db.prepare('SELECT COUNT(*) AS n FROM backup_sets').get() as { n: number }).n > 0;
  if (v === 0 && hasData && DB_PATH !== ':memory:') snapshotOnce(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const cols = (t: string) =>
      new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    const cat = cols('backup_catalog');
    if (!cat.has('node_uid')) db.exec('ALTER TABLE backup_catalog ADD COLUMN node_uid TEXT');
    const sets = cols('backup_sets');
    if (!sets.has('folder_uid')) db.exec('ALTER TABLE backup_sets ADD COLUMN folder_uid TEXT');
    if (!sets.has('source_marks')) db.exec('ALTER TABLE backup_sets ADD COLUMN source_marks TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Direct children of a folder (per-folder diff for mirror, verify). An index on
    // an expression of built-in functions: CLI-era releases maintain it unknowingly.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_parent ON backup_catalog (set_id, rtrim(rel, replace(rel, '/', '')))`);
    // Remember that this DB came from a CLI-era release (decides session takeover).
    if (v === 0 && hasData) db.prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)').run('upgrade.fromCli', String(Date.now()));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[db] schema migrated ${v} -> ${SCHEMA_VERSION}`);
}

function snapshotOnce(db: DatabaseSync) {
  const dest = preMigrationBackupPath();
  if (fs.existsSync(dest)) return;
  const tmp = `${dest}.tmp`;
  const clean = () => {
    for (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  };
  clean(); // leftovers of a snapshot interrupted by a kill
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    fs.renameSync(tmp, dest);
    clean();
    console.log(`[db] pre-migration snapshot written to ${dest}`);
  } catch (e) {
    // A full disk must not brick the upgrade: the migration itself is additive
    // and the old image can read the migrated file. Report and continue.
    clean();
    console.warn('[db] could not write the pre-migration snapshot:', e instanceof Error ? e.message : e);
  }
}

/** Compiled statements, cached for the connection lifetime (node:sqlite has no cache). */
const stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
export function stmt(sql: string) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

let txDepth = 0;
/** Run fn in one transaction (nestable via savepoints). */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  const sp = `sp${txDepth}`;
  db.exec(txDepth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const out = fn();
    txDepth--;
    db.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return out;
  } catch (e) {
    txDepth--;
    db.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

/** Small persistent key/value store (account binding, migration markers). */
export const meta = {
  get(key: string): string | null {
    const r = stmt('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  },
  set(key: string, value: string): void {
    stmt('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      key,
      value,
    );
  },
  delete(key: string): void {
    stmt('DELETE FROM app_meta WHERE key = ?').run(key);
  },
};

/**
 * What a source root looked like at the end of the last completed run: whether it
 * was its own mount (st_dev differs from its parent's) and whether it held any
 * entries. Lets Mirror tell an offline NAS share (the mountpoint is still there
 * but is now a plain, empty directory of the parent filesystem) from a folder the
 * user really emptied.
 */
export interface SourceMark {
  mounted: boolean;
  nonEmpty: boolean;
}

function parseMarks(raw: string | null): Record<string, SourceMark> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
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
    folderUid: r.folder_uid ?? null,
    sourceMarks: parseMarks(r.source_marks),
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
      getDb().prepare('SELECT * FROM backup_sets ORDER BY created_at DESC').all() as unknown as Row[]
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
    tx(() => {
      db.prepare(
        `UPDATE backup_catalog SET rel = ? || substr(rel, ?)
         WHERE set_id = ? AND (rel = ? OR rel LIKE ? ESCAPE '\\')`,
      ).run(newSub, oldSub.length + 1, id, oldSub, likePattern);
      db.prepare('UPDATE backup_sets SET target_subfolder = ? WHERE id = ?').run(newSub, id);
    });
  },

  /** Remember the Drive node of the set's own top-level folder (see engine bindings). */
  setFolderUid(id: string, uid: string | null): void {
    stmt('UPDATE backup_sets SET folder_uid = ? WHERE id = ?').run(uid, id);
  },

  /** Per-source mount marks from the last completed run (see engine sourceMarks). */
  setSourceMarks(id: string, marks: Record<string, SourceMark>): void {
    stmt('UPDATE backup_sets SET source_marks = ? WHERE id = ?').run(JSON.stringify(marks), id);
  },

  /**
   * Switching Proton accounts: every Drive node id and every catalog row belongs to
   * the old account, so forget them all. The next run of each set creates its
   * folder in the new account and uploads everything (explicit user action only).
   */
  resetAllBindings(): void {
    tx(() => {
      getDb().exec('DELETE FROM backup_catalog');
      getDb().exec('UPDATE backup_sets SET folder_uid = NULL, source_marks = NULL');
    });
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
