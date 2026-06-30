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
  it('returns the default (2) when no file exists', () => {
    expect(getUploadConfig()).toEqual({ concurrency: 2 });
  });

  it('reads a v2 value verbatim (clamped to 1-8)', () => {
    writeRaw({ v: 2, concurrency: 6 });
    expect(getUploadConfig().concurrency).toBe(6);
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
    expect(getUploadConfig()).toEqual({ concurrency: 2 }); // migrated, threshold dropped
  });
});

describe('setUploadConfig', () => {
  it('persists a clamped v2 value and reads back unmigrated', () => {
    expect(setUploadConfig({ concurrency: 5 })).toEqual({ concurrency: 5 });
    // Written as v2, so a re-read does NOT migrate it back down.
    expect(getUploadConfig().concurrency).toBe(5);
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual({ v: 2, concurrency: 5 });
  });

  it('clamps out-of-range input', () => {
    expect(setUploadConfig({ concurrency: 100 }).concurrency).toBe(8);
    expect(setUploadConfig({ concurrency: 0 }).concurrency).toBe(2); // 0 is falsy → default
  });
});
