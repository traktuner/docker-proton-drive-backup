import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDrive } from '../../test/fake-drive';
import { runSet, previewSet, verifySet, relBaseFor, type RunSpec } from '@/server/engine';
import { catalog } from '@/server/catalog';
import { LOCAL_ROOT } from '@/server/local';
import { backupSets, getDb } from '@/server/db';
import { setMirrorSafetyConfig } from '@/server/mirror-safety';

/**
 * Mirror + continuation folders ("<name> · part N"): what a user can do locally or
 * on Drive must never make the backup trash data that is still wanted, mix folders,
 * or get stuck.
 */
let n = 0;
let src = '';
let drive: FakeDrive;

function write(rel: string, content: string) {
  const abs = path.join(src, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function makeSet(mode: 'backup' | 'mirror'): RunSpec {
  const s = backupSets.create({ name: `MP${n}`, sourcePaths: [src], targetPath: '/', mode });
  return { setId: s.id, sourcePaths: [src], targetPath: '/my-files', subfolder: s.targetSubfolder, mode, skipThumbnails: true };
}
const remote = (spec: RunSpec, rel: string) => `${relBaseFor(spec.subfolder, src)}/${rel}`;
/** Live (not trashed) file names in Drive folder `rel`. */
const filesIn = (spec: RunSpec, rel: string) => {
  const f = drive.at(remote(spec, rel));
  if (!f || f.trashed) return [];
  return [...drive.nodes.values()].filter((x) => x.parentUid === f.uid && !x.trashed && x.kind === 'file').map((x) => x.name).sort();
};
/** All live file names of local folder `rel` across its Drive folder and parts. */
const allFiles = (spec: RunSpec, rel: string) => {
  const out: string[] = [...filesIn(spec, rel)];
  for (let p = 2; p < 10; p++) out.push(...filesIn(spec, `${rel} · part ${p}`));
  return out.sort();
};
const names = (k: number, prefix = 'f') => Array.from({ length: k }, (_, i) => `${prefix}${String(i).padStart(2, '0')}.jpg`);

async function splitSet(mode: 'backup' | 'mirror' = 'mirror') {
  for (const f of names(25)) write(`big/${f}`, f);
  for (let i = 0; i < 40; i++) write(`other/o${i}.txt`, `o${i}`); // keeps "big" below the 30 % gate
  const spec = makeSet(mode);
  drive.maxChildren = 10;
  const r = await runSet(drive, spec);
  expect(r.ok).toBe(true);
  expect(allFiles(spec, 'big')).toEqual(names(25));
  expect(catalog.parts(spec.setId, remote(spec, 'big')).length).toBe(2);
  return spec;
}

beforeEach(() => {
  n++;
  src = path.join(LOCAL_ROOT, `mp${n}`);
  fs.mkdirSync(src, { recursive: true });
  drive = new FakeDrive();
  getDb().exec('DELETE FROM backup_catalog; DELETE FROM backup_sets; DELETE FROM drive_parts; DELETE FROM listed_dirs;');
  setMirrorSafetyConfig({ enabled: true, deleteSafetyPct: 0.3 });
});

describe('Mirror with continuation folders', () => {
  it('files deleted locally are trashed from whichever part holds them; nothing else is touched', async () => {
    const spec = await splitSet();
    for (const f of ['f00.jpg', 'f12.jpg', 'f24.jpg']) fs.rmSync(path.join(src, 'big', f));
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(r.deletedCount).toBe(3);
    expect(allFiles(spec, 'big')).toEqual(names(25).filter((f) => !['f00.jpg', 'f12.jpg', 'f24.jpg'].includes(f)));
    expect(allFiles(spec, 'other')).toHaveLength(40); // 'other' is split too (limit 10)
  });

  it('a local folder that happens to be named "big · part 2" is never mixed with the continuation folder or trashed', async () => {
    const spec = await splitSet();
    const before = filesIn(spec, 'big · part 2');
    write('big · part 2/mine.txt', 'a real local folder');
    const r = await runSet(drive, spec);
    expect(r.deletedCount).toBe(0);
    expect(filesIn(spec, 'big · part 2')).toEqual(before); // nothing uploaded into, nothing trashed from it
    expect(allFiles(spec, 'big')).toEqual(names(25));
    // and the next run is not destructive either
    const r2 = await runSet(drive, spec);
    expect(r2.deletedCount).toBe(0);
    expect(allFiles(spec, 'big')).toEqual(names(25));
  });

  it('a file moved on Drive between parts is still ours: deleted locally -> trashed, nothing else', async () => {
    const spec = await splitSet();
    const p2 = drive.at(remote(spec, 'big · part 2'))!;
    const moved = drive.at(remote(spec, 'big/f01.jpg'))!;
    moved.parentUid = p2.uid; // the user tidied up on Drive
    fs.rmSync(path.join(src, 'big/f01.jpg'));
    const r = await runSet(drive, spec);
    expect(r.deletedCount).toBe(1);
    expect(moved.trashed).toBe(true);
    expect(allFiles(spec, 'big')).toEqual(names(25).filter((f) => f !== 'f01.jpg'));
  });

  it('something the user put into a part on Drive is kept, even when the local folder is removed', async () => {
    const spec = await splitSet();
    drive.putFile(remote(spec, 'big · part 2/foreign.doc'), 'not from this backup');
    fs.rmSync(path.join(src, 'big'), { recursive: true });
    setMirrorSafetyConfig({ enabled: false, deleteSafetyPct: 0.3 }); // let the deletion through
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(drive.at(remote(spec, 'big · part 2/foreign.doc'))?.trashed).toBe(false);
    expect(filesIn(spec, 'big · part 2')).toEqual(['foreign.doc']);
  });

  it('a part deleted on Drive: the run does not get stuck, and the missing files are uploaded again', async () => {
    const spec = await splitSet();
    const p3 = drive.at(remote(spec, 'big · part 3'))!;
    const lost = filesIn(spec, 'big · part 3');
    for (const [k, v] of drive.nodes) if (v.parentUid === p3.uid || k === p3.uid) drive.nodes.delete(k);
    write('big/new.jpg', 'new'); // goes to the (deleted) last part
    await runSet(drive, spec);
    const r2 = await runSet(drive, spec);
    expect(r2.ok).toBe(true);
    expect(allFiles(spec, 'big')).toEqual([...names(25), 'new.jpg'].sort());
    expect(lost.length).toBeGreaterThan(0);
  });

  it('Verify notices a part deleted on Drive (no upload needed to trigger it); the next run restores it', async () => {
    const spec = await splitSet();
    const p2 = drive.at(remote(spec, 'big · part 2'))!;
    for (const [k, v] of drive.nodes) if (v.parentUid === p2.uid || k === p2.uid) drive.nodes.delete(k);
    const v = await verifySet(drive, spec);
    expect(v.ok).toBe(true);
    expect(v.repaired).toBeGreaterThan(0);
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(allFiles(spec, 'big')).toEqual(names(25));
  });

  it('switching an existing Backup set to Mirror trashes only what is gone locally', async () => {
    const spec = await splitSet('backup');
    fs.rmSync(path.join(src, 'big/f05.jpg'));
    const r = await runSet(drive, { ...spec, mode: 'mirror' });
    expect(r.deletedCount).toBe(1);
    expect(allFiles(spec, 'big')).toEqual(names(25).filter((f) => f !== 'f05.jpg'));
  });

  it('renaming the local folder: the dry run shows it, the gate stops it when it is most of the set', async () => {
    for (const f of names(25)) write(`big/${f}`, f);
    write('x.txt', 'x');
    const spec = makeSet('mirror');
    drive.maxChildren = 10;
    await runSet(drive, spec);
    fs.renameSync(path.join(src, 'big'), path.join(src, 'Big Renamed'));
    const pv = await previewSet(drive, spec);
    expect(pv.deletionWouldSkip).toMatch(/would be removed/);
    const r = await runSet(drive, spec);
    expect(r.deletionSkipped).toMatch(/would be removed/);
    expect(allFiles(spec, 'big')).toEqual(names(25)); // old copy untouched
    expect(allFiles(spec, 'Big Renamed')).toEqual(names(25)); // new copy uploaded
  });
});
