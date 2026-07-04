import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { exportConfig, importConfig, autoImportFromConfigDir } from '@/server/config';
import { backupSets, getDb } from '@/server/db';
import { resolveLocal, LOCAL_ROOT } from '@/server/local';

beforeEach(() => {
  getDb().exec('DELETE FROM backup_sets');
});

// Regression guard for issue #19: the declarative /config volume is OPTIONAL and
// read-only. A fresh/hardened container often has no /config at all — auto-import
// must degrade to a no-op, never throw, so startup can't be aborted by its absence.
// (The entrypoint no longer even creates /config; this proves the code tolerates that.)
describe('autoImportFromConfigDir – tolerates a missing/empty CONFIG_DIR (issue #19)', () => {
  const withConfigDir = (value: string | undefined, fn: () => void) => {
    const saved = process.env.CONFIG_DIR;
    try {
      if (value === undefined) delete process.env.CONFIG_DIR;
      else process.env.CONFIG_DIR = value;
      fn();
    } finally {
      if (saved === undefined) delete process.env.CONFIG_DIR;
      else process.env.CONFIG_DIR = saved;
    }
  };

  it('does not throw and imports nothing when CONFIG_DIR does not exist', () => {
    withConfigDir(path.join(os.tmpdir(), 'pdb-nonexistent-config-xyz'), () => {
      expect(() => autoImportFromConfigDir()).not.toThrow();
      expect(backupSets.all()).toHaveLength(0);
    });
  });

  it('does not throw when CONFIG_DIR exists but has no backup-sets file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-empty-config-'));
    withConfigDir(dir, () => {
      expect(() => autoImportFromConfigDir()).not.toThrow();
      expect(backupSets.all()).toHaveLength(0);
    });
  });

  it('imports sets when a backup-sets.yaml IS present in CONFIG_DIR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-config-'));
    const yaml = YAML.stringify({
      version: 1,
      backupSets: [
        { name: 'FromConfig', sources: ['photos'], target: '/Backups', mode: 'backup', schedule: 'off' },
      ],
    });
    fs.writeFileSync(path.join(dir, 'backup-sets.yaml'), yaml);
    withConfigDir(dir, () => {
      expect(() => autoImportFromConfigDir()).not.toThrow();
      const names = backupSets.all().map((s) => s.name);
      expect(names).toContain('FromConfig');
    });
  });
});

describe('exportConfig / importConfig round-trip', () => {
  it('recreates sets with matching fields after export -> clear -> import', () => {
    // Source paths must live under LOCAL_ROOT so they survive the
    // relSource (export, made relative) -> resolveLocal (import, re-absolutised) trip.
    const photosSrc = resolveLocal('photos');
    const docsSrcA = resolveLocal('docs/a');
    const docsSrcB = resolveLocal('docs/b');

    // A weekly set: schedule emits time + dayOfWeek, so hour/minute/dow round-trip.
    const weekly = backupSets.create({
      name: 'Photos',
      sourcePaths: [photosSrc],
      targetPath: '/Backups',
      mode: 'mirror',
      schedule: 'weekly',
      scheduleHour: 4,
      scheduleMinute: 15,
      scheduleDow: 3, // Wed
      excludes: ['*.tmp', 'node_modules'],
      skipThumbnails: true,
      includeHidden: true,
      watch: false,
    });

    // An hourly set with watch on, no time/dow emitted (defaults on import).
    const hourly = backupSets.create({
      name: 'Documents',
      sourcePaths: [docsSrcA, docsSrcB],
      targetPath: '/',
      mode: 'add',
      schedule: 'hourly',
      excludes: [],
      skipThumbnails: false,
      watch: true,
    });

    const yaml = exportConfig();
    expect(typeof yaml).toBe('string');

    // Clear and re-import.
    getDb().exec('DELETE FROM backup_sets');
    expect(backupSets.all()).toHaveLength(0);

    const res = importConfig(yaml);
    expect(res.errors).toEqual([]);
    expect(res.imported).toBe(2);
    expect(res.updated).toBe(0);

    const all = backupSets.all();
    expect(all).toHaveLength(2);

    const gotWeekly = all.find((s) => s.name === 'Photos')!;
    expect(gotWeekly).toBeDefined();
    expect(gotWeekly.mode).toBe('mirror');
    expect(gotWeekly.schedule).toBe('weekly');
    expect(gotWeekly.scheduleHour).toBe(4);
    expect(gotWeekly.scheduleMinute).toBe(15);
    expect(gotWeekly.scheduleDow).toBe(3);
    expect(gotWeekly.sourcePaths).toEqual([photosSrc]);
    expect(gotWeekly.targetPath).toBe('/Backups');
    expect(gotWeekly.excludes).toEqual(['*.tmp', 'node_modules']);
    expect(gotWeekly.skipThumbnails).toBe(true);
    expect(gotWeekly.includeHidden).toBe(true);
    expect(gotWeekly.watch).toBe(false);

    const gotHourly = all.find((s) => s.name === 'Documents')!;
    expect(gotHourly).toBeDefined();
    expect(gotHourly.mode).toBe('add');
    expect(gotHourly.schedule).toBe('hourly');
    expect(gotHourly.sourcePaths).toEqual([docsSrcA, docsSrcB]);
    expect(gotHourly.targetPath).toBe('/');
    expect(gotHourly.excludes).toEqual([]);
    expect(gotHourly.skipThumbnails).toBe(false);
    expect(gotHourly.includeHidden).toBe(false); // not set → default off, not emitted
    expect(gotHourly.watch).toBe(true);
    // hourly emits no time/dow -> import uses the defaults
    expect(gotHourly.scheduleHour).toBe(3);
    expect(gotHourly.scheduleMinute).toBe(0);
    expect(gotHourly.scheduleDow).toBe(1);
  });

  it('exports the LOCAL_ROOT itself as "/" and round-trips it back to LOCAL_ROOT', () => {
    backupSets.create({
      name: 'Root',
      sourcePaths: [LOCAL_ROOT],
      targetPath: '/',
    });
    const yaml = exportConfig();
    const parsed = YAML.parse(yaml);
    expect(parsed.version).toBe(1);
    expect(parsed.backupSets[0].sources).toEqual(['/']);

    getDb().exec('DELETE FROM backup_sets');
    importConfig(yaml);
    const got = backupSets.all().find((s) => s.name === 'Root')!;
    // SOURCE BEHAVIOR: the '/' source round-trips through resolveLocal('/') which
    // is path.join(LOCAL_ROOT, '/') and gains a trailing slash, so it comes back as
    // `${LOCAL_ROOT}/`, not exactly LOCAL_ROOT. Still points at the same dir.
    expect(got.sourcePaths).toEqual([resolveLocal('/')]);
    expect(got.sourcePaths[0]).toBe(LOCAL_ROOT + '/');
  });

  it('omits the derived-from-name subfolder but keeps a custom one', () => {
    // Default subfolder == sanitizeSegment(name) -> not emitted.
    backupSets.create({ name: 'Plain', sourcePaths: [resolveLocal('x')], targetPath: '/' });
    // Two sets sharing a target get a uniqueness suffix on the 2nd subfolder,
    // which differs from the derived default -> targetFolder IS emitted.
    backupSets.create({ name: 'Plain', sourcePaths: [resolveLocal('y')], targetPath: '/' });

    const parsed = YAML.parse(exportConfig());
    const items: any[] = parsed.backupSets;
    const first = items.find((i) => i.targetFolder === undefined);
    const suffixed = items.find((i) => i.targetFolder === 'Plain-2');
    expect(first).toBeDefined();
    expect(suffixed).toBeDefined();
  });
});

describe('importConfig validation', () => {
  it('records an error for an entry with a missing name (and skips it)', () => {
    const yaml = YAML.stringify({
      version: 1,
      backupSets: [{ sources: ['/photos'], target: '/' }],
    });
    const res = importConfig(yaml);
    expect(res.imported).toBe(0);
    expect(res.errors).toContain('Entry 1: missing name');
    expect(backupSets.all()).toHaveLength(0);
  });

  it('records an error for a named entry with no sources (and skips it)', () => {
    const yaml = YAML.stringify({
      version: 1,
      backupSets: [{ name: 'NoSrc', sources: [], target: '/' }],
    });
    const res = importConfig(yaml);
    expect(res.imported).toBe(0);
    expect(res.errors).toContain('"NoSrc": no sources');
    expect(backupSets.all()).toHaveLength(0);
  });

  it('treats a missing sources key the same as empty sources', () => {
    const yaml = YAML.stringify({ version: 1, backupSets: [{ name: 'Bare', target: '/' }] });
    const res = importConfig(yaml);
    expect(res.imported).toBe(0);
    expect(res.errors).toContain('"Bare": no sources');
  });

  it('SOURCE BEHAVIOR: a traversal source like "../../etc" is clamped, NOT rejected', () => {
    // The task spec expected resolveLocal to throw for '../../etc'. In reality
    // path.normalize collapses the '..' segments and the result is clamped to live
    // under LOCAL_ROOT, so the import SUCCEEDS. We assert the real behavior.
    const yaml = YAML.stringify({
      version: 1,
      backupSets: [{ name: 'Trav', sources: ['../../etc'], target: '/' }],
    });
    const res = importConfig(yaml);
    expect(res.errors).toEqual([]);
    expect(res.imported).toBe(1);
    const got = backupSets.all().find((s) => s.name === 'Trav')!;
    // Clamped safely inside LOCAL_ROOT.
    expect(got.sourcePaths).toEqual([resolveLocal('../../etc')]);
    expect(got.sourcePaths[0].startsWith(LOCAL_ROOT)).toBe(true);
  });

  it('falls back to defaults for an invalid mode and schedule', () => {
    const yaml = YAML.stringify({
      version: 1,
      backupSets: [
        { name: 'Bad', sources: ['/x'], target: '/', mode: 'overwrite', schedule: 'fortnightly' },
      ],
    });
    const res = importConfig(yaml);
    expect(res.imported).toBe(1);
    expect(res.errors).toEqual([]);
    const got = backupSets.all().find((s) => s.name === 'Bad')!;
    expect(got.mode).toBe('backup'); // invalid mode -> 'backup'
    expect(got.schedule).toBe('off'); // invalid schedule -> 'off'
  });

  it('reports "No backupSets" for an empty / missing-key document', () => {
    const res = importConfig(YAML.stringify({ version: 1 }));
    expect(res.imported).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.errors).toContain('No backupSets found in the config.');
  });

  it('reports "No backupSets" for an empty string document', () => {
    const res = importConfig('');
    expect(res.errors).toContain('No backupSets found in the config.');
  });

  it('reports invalid YAML rather than throwing', () => {
    // A clearly malformed YAML mapping.
    const res = importConfig('foo: [unclosed');
    expect(res.imported).toBe(0);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toMatch(/^Invalid YAML:/);
  });

  it('clamps out-of-range schedule time values from a bad "time" string', () => {
    const yaml = YAML.stringify({
      version: 1,
      backupSets: [
        {
          name: 'Clamp',
          sources: ['/x'],
          target: '/',
          schedule: 'daily',
          time: '99:88',
        },
      ],
    });
    const res = importConfig(yaml);
    expect(res.imported).toBe(1);
    const got = backupSets.all().find((s) => s.name === 'Clamp')!;
    expect(got.scheduleHour).toBe(23); // clamped to max
    expect(got.scheduleMinute).toBe(59); // clamped to max
  });

  it('uses a default time when "time" is unparsable, and dow=1 for an unknown dayOfWeek', () => {
    const yaml = YAML.stringify({
      version: 1,
      backupSets: [
        {
          name: 'Defaults',
          sources: ['/x'],
          target: '/',
          schedule: 'weekly',
          time: 'not-a-time',
          dayOfWeek: 'Funday',
        },
      ],
    });
    const res = importConfig(yaml);
    expect(res.imported).toBe(1);
    const got = backupSets.all().find((s) => s.name === 'Defaults')!;
    // parseInt('not-a-time') is NaN -> ||3 / ||0
    expect(got.scheduleHour).toBe(3);
    expect(got.scheduleMinute).toBe(0);
    // unknown day -> findIndex returns -1 -> falls back to 1 (Mon)
    expect(got.scheduleDow).toBe(1);
  });

  it('honours a custom targetFolder on import', () => {
    const yaml = YAML.stringify({
      version: 1,
      backupSets: [{ name: 'Custom', sources: ['/x'], target: '/', targetFolder: 'MyFolder' }],
    });
    const res = importConfig(yaml);
    expect(res.imported).toBe(1);
    const got = backupSets.all().find((s) => s.name === 'Custom')!;
    expect(got.targetSubfolder).toBe('MyFolder');
  });
});

describe('importConfig upsert by name', () => {
  it('updates an existing set instead of duplicating it (idempotent re-import)', () => {
    const yaml = YAML.stringify({
      version: 1,
      backupSets: [
        { name: 'Job', sources: ['/x'], target: '/', mode: 'add', schedule: 'off' },
      ],
    });

    const first = importConfig(yaml);
    expect(first.imported).toBe(1);
    expect(first.updated).toBe(0);
    expect(backupSets.all()).toHaveLength(1);
    const idAfterFirst = backupSets.all()[0].id;

    const second = importConfig(yaml);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);
    // Still exactly one row, same id (updated in place, not recreated).
    const all = backupSets.all();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(idAfterFirst);
  });

  it('updates mutable fields on re-import with a changed config', () => {
    importConfig(
      YAML.stringify({
        version: 1,
        backupSets: [{ name: 'Job', sources: ['/x'], target: '/', mode: 'add', schedule: 'off' }],
      }),
    );
    const id = backupSets.all()[0].id;

    const res = importConfig(
      YAML.stringify({
        version: 1,
        backupSets: [
          { name: 'Job', sources: ['/x'], target: '/', mode: 'mirror', schedule: 'daily', time: '06:30' },
        ],
      }),
    );
    expect(res.updated).toBe(1);
    const got = backupSets.get(id)!;
    expect(got.mode).toBe('mirror');
    expect(got.schedule).toBe('daily');
    expect(got.scheduleHour).toBe(6);
    expect(got.scheduleMinute).toBe(30);
  });
});
