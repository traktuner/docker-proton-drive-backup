import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DELETE_SAFETY_PCT,
  getMirrorSafetyConfig,
  setMirrorSafetyConfig,
} from '@/server/mirror-safety';

const FILE = path.join(path.dirname(process.env.DB_PATH!), 'mirror-safety.json');

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe('global Mirror deletion safety', () => {
  it('keeps the historical 30% default when no settings file exists', () => {
    expect(getMirrorSafetyConfig()).toEqual({
      enabled: true,
      deleteSafetyPct: DEFAULT_DELETE_SAFETY_PCT,
    });
  });

  it('falls back to 30% when the settings file is malformed', () => {
    fs.writeFileSync(FILE, '{broken-json');

    expect(getMirrorSafetyConfig()).toEqual({
      enabled: true,
      deleteSafetyPct: DEFAULT_DELETE_SAFETY_PCT,
    });
  });

  it('persists a custom threshold and the explicit disabled state', () => {
    expect(setMirrorSafetyConfig({ deleteSafetyPct: 0.55 })).toEqual({
      enabled: true,
      deleteSafetyPct: 0.55,
    });
    expect(setMirrorSafetyConfig({ enabled: false })).toEqual({
      enabled: false,
      deleteSafetyPct: 0.55,
    });
    expect(getMirrorSafetyConfig()).toEqual({
      enabled: false,
      deleteSafetyPct: 0.55,
    });
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual({
      v: 1,
      enabled: false,
      deleteSafetyPct: 0.55,
    });
  });

  it('normalizes invalid stored values without throwing into a backup run', () => {
    fs.writeFileSync(FILE, JSON.stringify({ v: 1, enabled: 'no', deleteSafetyPct: 'invalid' }));

    expect(getMirrorSafetyConfig()).toEqual({
      enabled: true,
      deleteSafetyPct: DEFAULT_DELETE_SAFETY_PCT,
    });

    fs.writeFileSync(FILE, 'null');
    expect(getMirrorSafetyConfig()).toEqual({
      enabled: true,
      deleteSafetyPct: DEFAULT_DELETE_SAFETY_PCT,
    });
  });

  it('clamps direct callers to the supported 1-99% range', () => {
    expect(setMirrorSafetyConfig({ deleteSafetyPct: 0 }).deleteSafetyPct).toBe(0.01);
    expect(setMirrorSafetyConfig({ deleteSafetyPct: 10 }).deleteSafetyPct).toBe(0.99);
  });
});
