import fs from 'node:fs';
import path from 'node:path';

/**
 * Global upload tuning (persisted as JSON next to the DB).
 *  - thresholdMB: files smaller than this upload in parallel; larger ones serially.
 *  - concurrency: target simultaneous small-file uploads (1-8). The CLI does ~4
 *    internal streams per process, so 1-4 → 1 worker, 5-8 → 2 workers. Values
 *    that aren't 4/8 throttle via smaller batches (slower due to ~2.9s/call
 *    startup) - useful to be gentle on the connection.
 */
const FILE = path.join(path.dirname(process.env.DB_PATH || '/data/backup.db'), 'upload-config.json');

export interface UploadConfig {
  thresholdMB: number;
  concurrency: number;
}

const DEFAULTS: UploadConfig = { thresholdMB: 20, concurrency: 4 };

export function getUploadConfig(): UploadConfig {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setUploadConfig(patch: Partial<UploadConfig>): UploadConfig {
  const c = { ...getUploadConfig(), ...patch };
  // Cap at 10 GB - beyond that, even a 10 Gbit link can't transfer a single
  // file fast enough for parallel to make sense; such files belong in the serial lane.
  c.thresholdMB = Math.min(10_000, Math.max(1, Math.round(c.thresholdMB) || 20));
  c.concurrency = Math.min(8, Math.max(1, Math.round(c.concurrency) || 4));
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(c));
  } catch {
    /* best-effort */
  }
  return c;
}

/** Resolve concurrency into worker count + files-per-call batch sizing. */
export function resolvePlan(concurrency: number): { workers: number; streamsPerWorker: number } {
  const workers = concurrency <= 4 ? 1 : 2;
  const streamsPerWorker = Math.min(4, Math.ceil(concurrency / workers));
  return { workers, streamsPerWorker };
}
