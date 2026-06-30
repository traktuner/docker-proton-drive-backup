import fs from 'node:fs';
import path from 'node:path';

/**
 * Global upload tuning (persisted as JSON next to the DB).
 *  - concurrency: how many uploads run in parallel (1-8). Each is its own
 *    `proton-drive upload` process (which itself does ~4 internal streams), so a
 *    higher number is faster but heavier on the connection and likelier to hit
 *    Proton rate limits. The engine re-reads this live, so a change takes effect
 *    on the next batch of a running backup (graceful up/down-scaling), not just on
 *    the next run.
 */
const FILE = path.join(path.dirname(process.env.DB_PATH || '/data/backup.db'), 'upload-config.json');

export interface UploadConfig {
  concurrency: number;
}

const MIN = 1;
const MAX = 8;
const DEFAULTS: UploadConfig = { concurrency: 2 };
const CONFIG_VERSION = 2;

const clamp = (n: unknown): number =>
  Math.min(MAX, Math.max(MIN, Math.round(Number(n)) || DEFAULTS.concurrency));

export function getUploadConfig(): UploadConfig {
  let raw: { concurrency?: number; v?: number };
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { ...DEFAULTS }; // no file yet → defaults (no migration needed)
  }
  let concurrency = typeof raw.concurrency === 'number' ? raw.concurrency : DEFAULTS.concurrency;
  // v1 used a 1-8 slider that only ever resolved to 1 or 2 worker processes
  // (≤4 → 1, ≥5 → 2). v2 makes the number the literal count of parallel uploads, so
  // map an old value to its real equivalent — this keeps each existing install's
  // actual throughput unchanged until the user adjusts the slider themselves.
  if (raw.v !== CONFIG_VERSION) concurrency = concurrency <= 4 ? 1 : 2;
  return { concurrency: clamp(concurrency) };
}

export function setUploadConfig(patch: Partial<UploadConfig>): UploadConfig {
  const concurrency = clamp(patch.concurrency ?? getUploadConfig().concurrency);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ v: CONFIG_VERSION, concurrency }));
  } catch {
    /* best-effort */
  }
  return { concurrency };
}
