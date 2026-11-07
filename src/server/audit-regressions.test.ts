import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDrive } from '../../test/fake-drive';
import { runSet, previewSet, relBaseFor, partName, type RunSpec } from '@/server/engine';
import { catalog } from '@/server/catalog';
import { LOCAL_ROOT } from '@/server/local';
import { backupSets, getDb } from '@/server/db';
import { importConfig } from '@/server/config';
import { setMirrorSafetyConfig } from '@/server/mirror-safety';

/**
 * Regressions for the logic audit of the SDK branch (2026-11-07). Each test failed
 * on the code before its fix.
 */
let n = 0;
let src = '';
let drive: FakeDrive;

function write(rel: string, content: string | Buffer, mtimeMs?: number) {
  const abs = path.join(src, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtimeMs) fs.utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000);
  return abs;
}
function makeSet(mode: 'add' | 'backup' | 'mirror', extra: Partial<RunSpec> = {}): RunSpec {
  const s = backupSets.create({ name: `Audit${n}`, sourcePaths: [src], targetPath: '/', mode });
  return { setId: s.id, sourcePaths: [src], targetPath: '/my-files', subfolder: s.targetSubfolder, mode, skipThumbnails: true, ...extra };
}
const remote = (spec: RunSpec, rel: string) => `${relBaseFor(spec.subfolder, src)}/${rel}`;
const named = (name: string) => [...drive.nodes.values()].find((x) => x.name === name);

beforeEach(() => {
  n++;
  src = path.join(LOCAL_ROOT, `audit${n}`);
  fs.mkdirSync(src, { recursive: true });
  drive = new FakeDrive();
  getDb().exec('DELETE FROM backup_catalog; DELETE FROM backup_sets; DELETE FROM drive_parts; DELETE FROM listed_dirs;');
  setMirrorSafetyConfig({ enabled: true, deleteSafetyPct: 0.3 });
});

describe('Mirror safety gate counts what is below a removed folder', () => {
  it('a removed folder holding 90 % of the set is stopped by the 30 % gate (live and dry run)', async () => {
    for (let i = 0; i < 90; i++) write(`big/f${i}.txt`, `b${i}`);
    for (let i = 0; i < 10; i++) write(`small/f${i}.txt`, `s${i}`);
    const spec = makeSet('mirror');
    expect((await runSet(drive, spec)).ok).toBe(true);
    fs.rmSync(path.join(src, 'big'), { recursive: true });
    const pv = await previewSet(drive, spec);
    expect(pv.deletionWouldSkip).toMatch(/would be removed/);
    const r = await runSet(drive, spec);
    expect(r.deletionSkipped).toMatch(/would be removed/);
    expect(named('big')?.trashed).toBe(false);
  });

  it('a nested share that went offline (empty mountpoint) is not trashed', async () => {
    for (const top of ['Photos', 'Music', 'Docs']) for (let i = 0; i < 40; i++) write(`nas/${top}/sub/f${i}.bin`, `${top}${i}`);
    for (let i = 0; i < 5; i++) write(`local/l${i}.txt`, `l${i}`);
    const spec = makeSet('mirror');
    expect((await runSet(drive, spec)).ok).toBe(true);
    for (const top of ['Photos', 'Music', 'Docs']) fs.rmSync(path.join(src, 'nas', top), { recursive: true });
    const r = await runSet(drive, spec);
    expect(r.deletionSkipped).not.toBeNull();
    expect([...drive.nodes.values()].filter((x) => x.trashed)).toHaveLength(0);
  });
});

describe('"Include hidden files" switched off', () => {
  it('Mirror leaves hidden files and folders on Drive (like an exclude)', async () => {
    write('.env', 'secret');
    for (let i = 0; i < 20; i++) write(`.git/objects/o${i}`, `obj${i}`);
    for (let i = 0; i < 10; i++) write(`doc${i}.txt`, `d${i}`);
    const spec = makeSet('mirror', { includeHidden: true });
    expect((await runSet(drive, spec)).ok).toBe(true);
    const r = await runSet(drive, { ...spec, includeHidden: false });
    expect(r.ok).toBe(true);
    expect(r.deletedCount).toBe(0);
    expect(named('.git')?.trashed).toBe(false);
    expect(named('.env')?.trashed).toBe(false);
  });

  it('a config re-import without the key keeps the set\'s current value', () => {
    const s = backupSets.create({ name: 'Cfg', sourcePaths: [src], targetPath: '/', mode: 'mirror' });
    backupSets.update(s.id, { includeHidden: true, excludes: ['*.tmp'], skipThumbnails: true });
    const yaml = `backupSets:\n  - name: Cfg\n    sources: ["${path.relative(LOCAL_ROOT, src)}"]\n    target: /\n`;
    const res = importConfig(yaml);
    expect(res.errors).toEqual([]);
    const after = backupSets.get(s.id)!;
    expect(after.includeHidden).toBe(true);
    expect(after.excludes).toEqual(['*.tmp']);
    expect(after.skipThumbnails).toBe(true);
    expect(after.mode).toBe('mirror');
  });
});

describe('symbolic links', () => {
  it('a folder replaced by a symlink is not trashed, and the link is reported', async () => {
    for (let i = 0; i < 5; i++) write(`photos/p${i}.jpg`, `p${i}`);
    for (let i = 0; i < 20; i++) write(`other/o${i}.txt`, `o${i}`);
    const spec = makeSet('mirror');
    expect((await runSet(drive, spec)).ok).toBe(true);
    const elsewhere = path.join(LOCAL_ROOT, `elsewhere${n}`);
    fs.renameSync(path.join(src, 'photos'), elsewhere);
    fs.symlinkSync(elsewhere, path.join(src, 'photos'));
    const r = await runSet(drive, spec);
    expect(named('photos')?.trashed).toBe(false);
    expect(r.message).toMatch(/1 symbolic link not followed/);
    expect(r.failedFiles.some((f) => f.rel.endsWith('/photos') && /symbolic link/.test(f.reason))).toBe(true);
  });

  it('a symlinked file is reported, not silently ignored', async () => {
    write('real.txt', 'real');
    const target = path.join(LOCAL_ROOT, `t${n}.txt`);
    fs.writeFileSync(target, 'linked content');
    fs.symlinkSync(target, path.join(src, 'link.txt'));
    const r = await runSet(drive, makeSet('backup'));
    expect(r.message).toMatch(/symbolic link/);
  });
});

describe('continuation folders', () => {
  it('numbering continues after the highest part when a number was skipped', async () => {
    write('D · part 2/x.txt', 'x'); // a real local folder with that name
    write('D/f0.txt', 'f0');
    const spec = makeSet('backup');
    expect((await runSet(drive, spec)).ok).toBe(true);
    drive.maxChildren = 5;
    for (let i = 1; i < 12; i++) write(`D/f${i}.txt`, `f${i}`);
    const r = await runSet(drive, spec);
    expect(r.failedCount).toBe(0);
    expect(catalog.parts(spec.setId, remote(spec, 'D')).map((p) => p.part)).toEqual([3, 4]);
  });

  it('a part name never cuts a character in half', () => {
    const name = 'x'.repeat(230) + '📷'.repeat(8); // the old byte loop left half an emoji here
    const p = partName(name, 2);
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(255);
    expect(p).toBe(Buffer.from(p, 'utf8').toString('utf8')); // no lone surrogate
    expect(p.endsWith(' · part 2')).toBe(true);
  });
});

describe('Drive changed behind our back', () => {
  it('a subfolder deleted on Drive: its unchanged files are uploaded again, not "unchanged" forever', async () => {
    write('p/a.txt', 'a');
    write('p/b.txt', 'b');
    const spec = makeSet('backup');
    expect((await runSet(drive, spec)).ok).toBe(true);
    const p = drive.at(remote(spec, 'p'))!;
    for (const [k, v] of drive.nodes) if (v.parentUid === p.uid || k === p.uid) drive.nodes.delete(k);
    write('p/a.txt', 'a changed', Date.now() + 10_000);
    await runSet(drive, spec);
    const r3 = await runSet(drive, spec);
    expect(r3.ok).toBe(true);
    expect(drive.at(remote(spec, 'p/a.txt'))).toBeDefined();
    expect(drive.at(remote(spec, 'p/b.txt'))).toBeDefined();
  });

  it('a file renamed on Drive gets no revision under its old name: the file is uploaded anew', async () => {
    write('doc.txt', 'v1');
    const spec = makeSet('backup');
    await runSet(drive, spec);
    drive.at(remote(spec, 'doc.txt'))!.name = 'renamed-by-user.txt';
    write('doc.txt', 'version 2', Date.now() + 10_000);
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(drive.at(remote(spec, 'doc.txt'))?.revisions).toHaveLength(1);
    expect(named('renamed-by-user.txt')?.revisions).toHaveLength(1);
  });

  it('Mirror: a file replaced locally by a folder of the same name no longer blocks the set', async () => {
    write('x', 'i am a file');
    for (let i = 0; i < 10; i++) write(`keep/k${i}.txt`, `k${i}`);
    write('gone.txt', 'will be deleted');
    const spec = makeSet('mirror');
    expect((await runSet(drive, spec)).ok).toBe(true);
    fs.rmSync(path.join(src, 'x'));
    write('x/inside.txt', 'now a folder');
    fs.rmSync(path.join(src, 'gone.txt'));
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(drive.at(remote(spec, 'x'))?.kind).toBe('folder');
    expect(drive.at(remote(spec, 'x/inside.txt'))).toBeDefined();
    expect(named('gone.txt')?.trashed).toBe(true);
  });
});

describe('cancel', () => {
  it('no empty-folder worker outlives a cancelled run', async () => {
    for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(src, `e${i}`), { recursive: true });
    for (let i = 0; i < 60; i++) write(`zz/file${i}.txt`, `x${i}`);
    const spec = makeSet('backup');
    let cancel = false;
    let eCalls = 0;
    const origC = drive.createFolder.bind(drive);
    drive.createFolder = async (p: string, nm: string) => {
      if (/^e\d+$/.test(nm)) {
        if (++eCalls === 3) cancel = true;
        await new Promise((r) => setTimeout(r, 30));
      }
      return origC(p, nm);
    };
    const r = await runSet(drive, spec, { shouldCancel: () => cancel });
    cancel = false; // what the runner does after the run returned
    const atReturn = eCalls;
    await new Promise((res) => setTimeout(res, 500));
    expect(r.cancelled).toBe(true);
    expect(eCalls).toBe(atReturn);
  });
});

describe('Drive folder uniqueness across sets', () => {
  it('"/Backups" and "/my-files/Backups/" are the same target', () => {
    const a = backupSets.create({ name: 'Same', sourcePaths: [src], targetPath: '/Backups', mode: 'backup' });
    const b = backupSets.create({ name: 'Same2', sourcePaths: [src], targetPath: '/my-files/Backups/', mode: 'backup', targetSubfolder: 'Same' });
    expect(a.targetSubfolder).toBe('Same');
    expect(b.targetSubfolder).toBe('Same-2');
  });

  it('renaming a set folder with an emoji keeps every key (and the listed-once records)', () => {
    const s = backupSets.create({ name: '📷 Photos', sourcePaths: [src], targetPath: '/', mode: 'backup' });
    const sub = s.targetSubfolder;
    catalog.upsertDir(s.id, sub, 1, 'u0');
    catalog.upsertDir(s.id, `${sub}/a`, 1, 'u1');
    catalog.upsertFile(s.id, `${sub}/a/x.jpg`, 1, 1, null, 1, 'u2');
    catalog.markListed(s.id, `${sub}/a`);
    backupSets.renameSubfolder(s.id, sub, 'Pictures');
    expect(catalog.getFile(s.id, 'Pictures/a/x.jpg')?.nodeUid).toBe('u2');
    expect(catalog.isListed(s.id, 'Pictures/a')).toBe(true);
  });
});
