import fs from 'node:fs';
import path from 'node:path';

/**
 * Global Mirror deletion safety, persisted next to the SQLite database.
 *
 * Existing installations have no file, so reads must always fall back to the
 * historical 30% threshold. A missing, unreadable, or malformed settings file
 * must never prevent a backup from running.
 */
const FILE = path.join(path.dirname(process.env.DB_PATH || '/data/backup.db'), 'mirror-safety.json');

export const DEFAULT_DELETE_SAFETY_PCT = 0.3;

export interface MirrorSafetyConfig {
  /** Disable only the percentage gate. Missing sources and upload failures stay protected. */
  enabled: boolean;
  /** Fraction of catalog entries (0.01-0.99) that may disappear in one Mirror run. */
  deleteSafetyPct: number;
}

const DEFAULTS: MirrorSafetyConfig = {
  enabled: true,
  deleteSafetyPct: DEFAULT_DELETE_SAFETY_PCT,
};
const CONFIG_VERSION = 1;
const MIN_DELETE_SAFETY_PCT = 0.01;
// Keep 100% reserved for the explicit disabled state. Otherwise the UI could say
// the guard is enabled while a complete catalog wipe still bypasses it.
const MAX_DELETE_SAFETY_PCT = 0.99;

function clampDeleteSafetyPct(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DELETE_SAFETY_PCT, Math.max(MIN_DELETE_SAFETY_PCT, n));
}

export function getMirrorSafetyConfig(): MirrorSafetyConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
  } catch {
    return { ...DEFAULTS };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULTS };
  }
  const raw = parsed as { enabled?: unknown; deleteSafetyPct?: unknown };

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    deleteSafetyPct: clampDeleteSafetyPct(raw.deleteSafetyPct, DEFAULTS.deleteSafetyPct),
  };
}

export function setMirrorSafetyConfig(patch: Partial<MirrorSafetyConfig>): MirrorSafetyConfig {
  const current = getMirrorSafetyConfig();
  const next: MirrorSafetyConfig = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    deleteSafetyPct: clampDeleteSafetyPct(patch.deleteSafetyPct, current.deleteSafetyPct),
  };

  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temporary = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ v: CONFIG_VERSION, ...next }));
    fs.renameSync(temporary, FILE);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
  return next;
}
