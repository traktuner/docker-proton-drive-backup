import fs from 'node:fs';
import path from 'node:path';

/**
 * Global upload tuning (persisted as JSON next to the DB). The engine re-reads it
 * about once a second, so a change applies during a running backup.
 *  - concurrency: files uploaded in parallel (1-5).
 *  - limitKBps: read-speed cap for uploads (traffic.ts); 0 = off.
 */
const FILE = path.join(path.dirname(process.env.DB_PATH || '/data/backup.db'), 'upload-config.json');

export interface UploadConfig {
  concurrency: number;
  /** Upload speed cap in KB/s. 0 = unlimited (off). Enforced in-app (traffic.ts). */
  limitKBps: number;
}

const MIN = 1;
// The SDK itself never runs more than 5 file uploads (and 40 MiB of file data) at
// once (internal/upload/queue.ts), so higher values would only queue in memory.
const MAX = 5;
// Speed-cap floor: a very low cap makes block uploads time out at Proton, so
// anything above 0 is clamped up to this.
const MIN_KBPS = 50;
const MAX_KBPS = 1_000_000; // ~8 Gbps — a sanity ceiling, effectively unlimited
const DEFAULTS: UploadConfig = { concurrency: 2, limitKBps: 0 };
const CONFIG_VERSION = 3;

const clamp = (n: unknown): number =>
  Math.min(MAX, Math.max(MIN, Math.round(Number(n)) || DEFAULTS.concurrency));

/** 0 (off) or clamped to [MIN_KBPS, MAX_KBPS]. */
const clampLimit = (n: unknown): number => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_KBPS, Math.max(MIN_KBPS, v));
};

export function getUploadConfig(): UploadConfig {
  let raw: { concurrency?: number; limitKBps?: number; v?: number };
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { ...DEFAULTS }; // no file yet → defaults (no migration needed)
  }
  let concurrency = typeof raw.concurrency === 'number' ? raw.concurrency : DEFAULTS.concurrency;
  // v1 (no version field) used a 1-8 slider that only ever resolved to 1 or 2 worker
  // processes (≤4 → 1, ≥5 → 2). v2 makes the number the literal count of parallel
  // uploads, so map an old value to its real equivalent — keeping each existing
  // install's throughput unchanged until the user adjusts it. v2+ values are verbatim
  // (a version-aware check, so bumping to v3 does NOT re-migrate a v2 concurrency).
  if (raw.v == null || raw.v < 2) concurrency = concurrency <= 4 ? 1 : 2;
  const limitKBps = typeof raw.limitKBps === 'number' ? raw.limitKBps : DEFAULTS.limitKBps;
  return { concurrency: clamp(concurrency), limitKBps: clampLimit(limitKBps) };
}

export function setUploadConfig(patch: Partial<UploadConfig>): UploadConfig {
  const cur = getUploadConfig();
  const next: UploadConfig = {
    concurrency: clamp(patch.concurrency ?? cur.concurrency),
    // `??` (not `||`) so an explicit 0 turns the limit OFF instead of falling back.
    limitKBps: clampLimit(patch.limitKBps ?? cur.limitKBps),
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ v: CONFIG_VERSION, ...next }));
  } catch {
    /* best-effort */
  }
  return next;
}
