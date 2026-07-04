import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getUploadConfig, setUploadConfig } from '@/server/upload-config';

// The module persists to "<dirname(DB_PATH)>/upload-config.json" (computed at
// import from the env the test harness set up). Drive it directly to exercise the
// read/migration paths without going through the HTTP route.
const FILE = path.join(path.dirname(process.env.DB_PATH!), 'upload-config.json');
const writeRaw = (obj: unknown) => fs.writeFileSync(FILE, JSON.stringify(obj));

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe('getUploadConfig', () => {
  it('returns the defaults (concurrency 2, no limit) when no file exists', () => {
    expect(getUploadConfig()).toEqual({ concurrency: 2, limitKBps: 0 });
  });

  it('reads a v2 value verbatim (clamped to 1-8) and does NOT re-migrate on the v3 bump', () => {
    writeRaw({ v: 2, concurrency: 6 });
    expect(getUploadConfig()).toEqual({ concurrency: 6, limitKBps: 0 }); // 6 kept, not remapped to 2
    writeRaw({ v: 2, concurrency: 99 });
    expect(getUploadConfig().concurrency).toBe(8);
    writeRaw({ v: 2, concurrency: -3 });
    expect(getUploadConfig().concurrency).toBe(1);
  });

  it('migrates a v1 file (no version) to its real worker count: ≤4 → 1, ≥5 → 2', () => {
    for (const old of [1, 2, 3, 4]) {
      writeRaw({ concurrency: old }); // v1 = no "v" field
      expect(getUploadConfig().concurrency).toBe(1);
    }
    for (const old of [5, 6, 7, 8]) {
      writeRaw({ concurrency: old });
      expect(getUploadConfig().concurrency).toBe(2);
    }
  });

  it('ignores a stale thresholdMB field left over from v1', () => {
    writeRaw({ thresholdMB: 500, concurrency: 8 });
    expect(getUploadConfig()).toEqual({ concurrency: 2, limitKBps: 0 }); // migrated, threshold dropped
  });
});

describe('setUploadConfig', () => {
  it('persists a clamped value and reads back unmigrated (now v3)', () => {
    expect(setUploadConfig({ concurrency: 5 })).toEqual({ concurrency: 5, limitKBps: 0 });
    // Written as the current version, so a re-read does NOT migrate concurrency down.
    expect(getUploadConfig().concurrency).toBe(5);
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual({ v: 3, concurrency: 5, limitKBps: 0 });
  });

  it('clamps out-of-range concurrency input', () => {
    expect(setUploadConfig({ concurrency: 100 }).concurrency).toBe(8);
    expect(setUploadConfig({ concurrency: 0 }).concurrency).toBe(2); // 0 is falsy → default
  });
});

describe('upload speed limit (issue #23)', () => {
  it('defaults to 0 (off)', () => {
    expect(getUploadConfig().limitKBps).toBe(0);
  });

  it('persists a limit and round-trips it', () => {
    expect(setUploadConfig({ limitKBps: 500 }).limitKBps).toBe(500);
    expect(getUploadConfig().limitKBps).toBe(500);
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8')).limitKBps).toBe(500);
  });

  it('clamps: a positive value below the 50 KB/s floor is raised to 50', () => {
    expect(setUploadConfig({ limitKBps: 10 }).limitKBps).toBe(50);
    expect(setUploadConfig({ limitKBps: 1 }).limitKBps).toBe(50);
  });

  it('treats 0 / negative / NaN as OFF (not floored to 50)', () => {
    setUploadConfig({ limitKBps: 500 }); // turn it on first
    expect(setUploadConfig({ limitKBps: 0 }).limitKBps).toBe(0);
    expect(setUploadConfig({ limitKBps: -5 }).limitKBps).toBe(0);
    expect(setUploadConfig({ limitKBps: NaN }).limitKBps).toBe(0);
  });

  it('caps an absurd value at the ceiling', () => {
    expect(setUploadConfig({ limitKBps: 9_999_999_999 }).limitKBps).toBe(1_000_000);
  });

  it('changing the limit leaves concurrency untouched, and vice-versa', () => {
    setUploadConfig({ concurrency: 7 });
    expect(setUploadConfig({ limitKBps: 200 })).toEqual({ concurrency: 7, limitKBps: 200 });
    expect(setUploadConfig({ concurrency: 3 })).toEqual({ concurrency: 3, limitKBps: 200 });
  });

  it('migrates a v2 file (no limitKBps) to limit 0 without touching concurrency', () => {
    writeRaw({ v: 2, concurrency: 6 });
    expect(getUploadConfig()).toEqual({ concurrency: 6, limitKBps: 0 });
  });
});
