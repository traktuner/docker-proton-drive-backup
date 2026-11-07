import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDrive } from '../../test/fake-drive';
import { runSet, restoreTest, relBaseFor, type RunSpec } from '@/server/engine';
import { catalog } from '@/server/catalog';
import { LOCAL_ROOT } from '@/server/local';
import { backupSets, getDb } from '@/server/db';
import { setMirrorSafetyConfig } from '@/server/mirror-safety';

/**
 * Many sets, every mode, run at the same time against one Drive — then "restored"
 * (Drive bytes compared with the local files) — and the restore test itself.
 */
let n = 0;
let root = '';
let drive: FakeDrive;
type Mode = 'add' | 'backup' | 'mirror';

function write(abs: string, content: string, mtimeMs?: number) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtimeMs) fs.utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000);
}
function makeSet(name: string, src: string, mode: Mode): RunSpec {
  const s = backupSets.create({ name, sourcePaths: [src], targetPath: '/', mode });
  return { setId: s.id, sourcePaths: [src], targetPath: '/my-files', subfolder: s.targetSubfolder, mode, skipThumbnails: true };
}
const remote = (spec: RunSpec, src: string, rel: string) => `${relBaseFor(spec.subfolder, src)}/${rel}`;
const content = (spec: RunSpec, src: string, rel: string) => {
  const node = drive.at(remote(spec, src, rel));
  if (!node || node.trashed) return undefined;
  return node.revisions[node.revisions.length - 1].content.toString();
};
/** Every local file of `src` is on Drive, under this set, with the same bytes. */
function expectRestorable(spec: RunSpec, src: string) {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const abs of walk(src)) {
    const rel = path.relative(src, abs);
    expect(content(spec, src, rel), `${spec.subfolder}: ${rel}`).toBe(fs.readFileSync(abs, 'utf8'));
  }
}

beforeEach(() => {
  n++;
  root = path.join(LOCAL_ROOT, `par${n}`);
  drive = new FakeDrive();
  getDb().exec('DELETE FROM backup_catalog; DELETE FROM backup_sets; DELETE FROM drive_parts; DELETE FROM listed_dirs;');
  setMirrorSafetyConfig({ enabled: true, deleteSafetyPct: 0.3 });
});

describe('many sets, every mode, at the same time', () => {
  it('each set backs up exactly its own files; changes follow each mode; nothing leaks between sets', async () => {
    const t = Date.now() - 3_600_000;
    const shared = path.join(root, 'shared'); // two sets back up the same folder
    const own: string[] = [];
    for (let i = 0; i < 40; i++) write(path.join(shared, `d${i % 4}/s${i}.txt`), `shared-${i}`, t);
    const modes: Mode[] = ['add', 'backup', 'mirror', 'add', 'backup', 'mirror'];
    const specs = modes.map((mode, k) => {
      const src = k < 2 ? shared : path.join(root, `own${k}`);
      if (k >= 2) {
        own.push(src);
        for (let i = 0; i < 30; i++) write(path.join(src, `f${i % 3}/x${i}.bin`), `set${k}-file${i}`, t);
      }
      return { spec: makeSet(`Set ${k} ${mode}`, src, mode), src };
    });
    drive.maxChildren = 12; // and some folders overflow into "· part N" along the way

    const r1 = await Promise.all(specs.map(({ spec }) => runSet(drive, spec)));
    for (const r of r1) expect(r.ok, r.message).toBe(true);
    for (const { spec, src } of specs) expectRestorable(spec, src);
    for (const { spec, src } of specs) expect(catalog.countFiles(spec.setId)).toBe(src === shared ? 40 : 30);

    // Change one file, delete one, add one, in every source.
    const later = Date.now() + 60_000;
    const change = (src: string) => (src === shared ? 'd1/s1.txt' : 'f1/x1.bin');
    const gone = (src: string) => (src === shared ? 'd2/s2.txt' : 'f2/x2.bin');
    for (const src of [shared, ...own]) {
      write(path.join(src, change(src)), `changed-${src}`, later);
      fs.rmSync(path.join(src, gone(src)));
      write(path.join(src, 'new/added.txt'), `added-${src}`, later);
    }
    const r2 = await Promise.all(specs.map(({ spec }) => runSet(drive, spec)));
    for (const r of r2) expect(r.ok, r.message).toBe(true);

    for (const { spec, src } of specs) {
      const changed = drive.at(remote(spec, src, change(src)))!;
      expect(content(spec, src, 'new/added.txt')).toBe(`added-${src}`); // every mode uploads new files
      if (spec.mode === 'add') {
        expect(changed.revisions).toHaveLength(1); // add never updates
        expect(content(spec, src, gone(src))).toBeDefined();
      } else {
        expect(changed.revisions).toHaveLength(2); // exactly one new revision
        expect(content(spec, src, change(src))).toBe(`changed-${src}`);
        if (spec.mode === 'backup') expect(content(spec, src, gone(src))).toBeDefined(); // kept
        else expect(content(spec, src, gone(src))).toBeUndefined(); // mirror: trashed
      }
    }
    // The two sets on the same folder have their own Drive copies and catalogs.
    const [a, b] = specs;
    expect(drive.at(remote(a.spec, shared, 'd0/s0.txt'))!.uid).not.toBe(drive.at(remote(b.spec, shared, 'd0/s0.txt'))!.uid);
    const uidsA = new Set(catalog.sampleFiles(a.spec.setId, 1000, Infinity).map((f) => f.nodeUid));
    for (const f of catalog.sampleFiles(b.spec.setId, 1000, Infinity)) expect(uidsA.has(f.nodeUid)).toBe(false);

    // A third run of everything is a no-op.
    drive.reset();
    const r3 = await Promise.all(specs.map(({ spec }) => runSet(drive, spec)));
    for (const r of r3) expect(r.ok).toBe(true);
    expect(drive.calls.uploadNew + drive.calls.uploadRevision + drive.calls.trash).toBe(0);
  });
});

describe('restore test (download and compare)', () => {
  it('passes when Drive returns the original bytes, reports corruption, skips files changed locally', async () => {
    const src = path.join(root, 'r');
    for (let i = 0; i < 10; i++) write(path.join(src, `p${i}.jpg`), `photo-${i}`);
    const spec = makeSet('R', src, 'backup');
    expect((await runSet(drive, spec)).ok).toBe(true);

    const pass = await restoreTest(drive, spec, { files: 10 });
    expect(pass).toMatchObject({ ok: true, tested: 10, identical: 10, skipped: 0 });
    expect(pass.message).toMatch(/passed: 10 of 10/);

    drive.corrupt.add('p3.jpg');
    write(path.join(src, 'p5.jpg'), 'edited locally since the backup', Date.now() + 60_000);
    const fail = await restoreTest(drive, spec, { files: 10 });
    expect(fail.ok).toBe(false);
    expect(fail.skipped).toBe(1);
    expect(fail.mismatched.map((m) => path.basename(m.rel))).toEqual(['p3.jpg']);
    expect(fail.message).toMatch(/FAILED for 1 of 9/);
    expect(fs.readdirSync(require('node:os').tmpdir()).some((d: string) => d.startsWith('pdb-restore-'))).toBe(false); // temp cleaned
  });
});
