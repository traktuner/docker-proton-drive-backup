import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDrive } from '../../test/fake-drive';
import { runSet, previewSet, verifySet, relBaseFor, topMost, engineActivity, type RunSpec } from '@/server/engine';
import { catalog } from '@/server/catalog';
import { LOCAL_ROOT } from '@/server/local';
import { backupSets, getDb } from '@/server/db';
import { setMirrorSafetyConfig } from '@/server/mirror-safety';

const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex');
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
  const s = backupSets.create({ name: `Set${n}`, sourcePaths: [src], targetPath: '/', mode });
  return {
    setId: s.id,
    sourcePaths: [src],
    targetPath: '/my-files',
    subfolder: s.targetSubfolder,
    mode,
    skipThumbnails: true,
    ...extra,
  };
}

/** Remote path of a local file of the set (relative to the set folder on Drive). */
const remote = (spec: RunSpec, rel: string) => `${relBaseFor(spec.subfolder, src)}/${rel}`;

beforeEach(() => {
  n++;
  src = path.join(LOCAL_ROOT, `src${n}`);
  fs.mkdirSync(src, { recursive: true });
  drive = new FakeDrive();
  getDb().exec('DELETE FROM backup_catalog; DELETE FROM backup_sets;');
  setMirrorSafetyConfig({ enabled: true, deleteSafetyPct: 0.3 });
});

describe('first run and the unchanged follow-up run', () => {
  it('uploads everything once; an unchanged re-run makes zero uploads, revisions, deletions and reads', async () => {
    write('a.txt', 'alpha');
    write('sub/b.txt', 'beta');
    write('sub/deep/c.txt', 'gamma');
    const spec = makeSet('mirror');
    const r1 = await runSet(drive, spec);
    expect(r1.ok).toBe(true);
    expect(r1.newCount).toBe(3);
    expect(drive.at(remote(spec, 'sub/deep/c.txt'))?.revisions).toHaveLength(1);

    drive.reset();
    const r2 = await runSet(drive, spec);
    expect(r2.ok).toBe(true);
    expect(r2.unchangedCount).toBe(3);
    expect(drive.calls.uploadNew + drive.calls.uploadRevision + drive.calls.trash + drive.calls.createFolder).toBe(0);
    expect(drive.bytesRead).toBe(0);
    // Only the target/set-folder identity check touches Drive.
    expect(drive.calls.getNode).toBe(1);
  });

  it('a changed file becomes exactly one new revision of the SAME node', async () => {
    write('doc.txt', 'v1');
    const spec = makeSet('backup');
    await runSet(drive, spec);
    const node = drive.at(remote(spec, 'doc.txt'))!;
    write('doc.txt', 'version 2', Date.now() + 10_000);
    drive.reset();
    const r = await runSet(drive, spec);
    expect(r.changedCount).toBe(1);
    expect(drive.calls.uploadRevision).toBe(1);
    expect(drive.calls.uploadNew).toBe(0);
    expect(drive.at(remote(spec, 'doc.txt'))!.uid).toBe(node.uid);
    expect(node.revisions.map((x) => x.content.toString())).toEqual(['v1', 'version 2']);
  });

  it('handles empty files, empty folders and special characters', async () => {
    write('empty.bin', '');
    fs.mkdirSync(path.join(src, 'empty dir/nested'), { recursive: true });
    write('Movie [1080p] {x} *?.mkv', 'm');
    write('ümlaut ñ 日本/ä#%&.txt', 'u');
    const spec = makeSet('mirror');
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(drive.at(remote(spec, 'empty.bin'))?.revisions[0].size).toBe(0);
    expect(drive.at(remote(spec, 'empty dir/nested'))?.kind).toBe('folder');
    expect(drive.at(remote(spec, 'Movie [1080p] {x} *?.mkv'))).toBeDefined();
    expect(drive.at(remote(spec, 'ümlaut ñ 日本/ä#%&.txt'))).toBeDefined();
    // and nothing is "stale" on the next run: empty folders are kept, not trashed
    drive.reset();
    const r2 = await runSet(drive, spec);
    expect(r2.deletedCount).toBe(0);
    expect(drive.calls.trash).toBe(0);
  });
});

describe('upgrade from a CLI-era catalog (no node ids, no digests)', () => {
  it('first SDK run: zero uploads; one changed file → one revision of the existing Drive file', async () => {
    const mtime = Date.now() - 86_400_000;
    write('p/one.jpg', 'one', mtime);
    write('p/two.jpg', 'two', mtime);
    const spec = makeSet('mirror');
    // What the CLI release left behind: files on Drive, catalog rows WITHOUT node_uid/sha1.
    const base = relBaseFor(spec.subfolder, src);
    drive.putFile(`${base}/p/one.jpg`, 'one', mtime);
    drive.putFile(`${base}/p/two.jpg`, 'two', mtime);
    for (const d of [spec.subfolder, base, `${base}/p`]) catalog.upsertDir(spec.setId, d, 1);
    catalog.upsertFile(spec.setId, `${base}/p/one.jpg`, 3, mtime, null, 1);
    catalog.upsertFile(spec.setId, `${base}/p/two.jpg`, 3, mtime, null, 1);

    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(r.unchangedCount).toBe(2);
    expect(drive.calls.uploadNew + drive.calls.uploadRevision + drive.calls.trash).toBe(0);
    expect(drive.revisionCount).toBe(2);

    write('p/two.jpg', 'TWO!', Date.now());
    const before = drive.at(`${base}/p/two.jpg`)!;
    drive.reset();
    const r2 = await runSet(drive, spec);
    expect(r2.changedCount).toBe(1);
    expect(drive.calls.uploadRevision).toBe(1);
    expect(drive.calls.uploadNew).toBe(0);
    expect(before.revisions).toHaveLength(2);
    expect(catalog.getFile(spec.setId, `${base}/p/two.jpg`)?.nodeUid).toBe(before.uid);
  });

  it('mtime drift with a CLI-era row (no digest) compares with Drive instead of re-uploading', async () => {
    const spec = makeSet('backup');
    const base = relBaseFor(spec.subfolder, src);
    write('x.txt', 'same', Date.now());
    drive.putFile(`${base}/x.txt`, 'same', Date.now() - 100_000);
    for (const d of [spec.subfolder, base]) catalog.upsertDir(spec.setId, d, 1);
    catalog.upsertFile(spec.setId, `${base}/x.txt`, 4, Date.now() - 100_000, null, 1);
    const r = await runSet(drive, spec);
    expect(r.unchangedCount).toBe(1);
    expect(drive.calls.uploadRevision + drive.calls.uploadNew).toBe(0);
    expect(catalog.getFile(spec.setId, `${base}/x.txt`)?.sha1).toBe(sha1('same'));
  });
});

describe('first SDK run after an interrupted CLI first upload (files on Drive, not in the catalog)', () => {
  it('adopts them from one listing per folder: no upload, no conflict round trip, no file read', async () => {
    const t = Date.now() - 3_600_000;
    for (let d = 0; d < 3; d++) for (let i = 0; i < 20; i++) write(`y${d}/f${i}.jpg`, `photo ${d}-${i}`, t);
    const spec = makeSet('mirror');
    for (let d = 0; d < 3; d++) for (let i = 0; i < 20; i++) drive.putFile(remote(spec, `y${d}/f${i}.jpg`), `photo ${d}-${i}`, t);
    write('y0/new.jpg', 'genuinely new', t);
    drive.reset();
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(r.adoptedCount).toBe(60);
    expect(drive.calls.uploadNew).toBe(1); // only the genuinely new file
    expect(drive.calls.uploadRevision + drive.calls.getNode).toBe(0); // no per-file node lookups
    expect(drive.bytesRead).toBe('genuinely new'.length);
    expect(catalog.countFiles(spec.setId)).toBe(61);
  });
});

describe('an existing Drive folder is listed once, ever', () => {
  it('adopts while listing and never lists that folder again just to find uploaded files', async () => {
    const t = Date.now() - 3_600_000;
    const spec = makeSet('backup');
    for (let i = 0; i < 30; i++) {
      write(`old/f${i}.jpg`, `p${i}`, t);
      drive.putFile(remote(spec, `old/f${i}.jpg`), `p${i}`, t);
    }
    write('old/new1.jpg', 'new one', t);
    const r1 = await runSet(drive, spec);
    expect(r1.adoptedCount).toBe(30);
    expect(r1.newCount).toBe(1);
    const folderUid = drive.at(remote(spec, 'old'))!.uid;
    write('old/new2.jpg', 'new two', t);
    let listedOld = 0;
    const orig = drive.children.bind(drive);
    drive.children = (uid: string) => {
      if (uid === folderUid) listedOld++;
      return orig(uid);
    };
    const r2 = await runSet(drive, spec);
    expect(r2.newCount).toBe(1);
    expect(listedOld).toBe(0);
  });

  it('names the folder being listed in the progress and records the finished listing', async () => {
    const t = Date.now() - 3_600_000;
    const spec = makeSet('backup');
    drive.mkdirp(remote(spec, 'graph'));
    for (let i = 0; i < 1000; i++) drive.putFile(remote(spec, `graph/old${i}.jpg`), 'x', t);
    write('graph/new.jpg', 'new', t);
    drive.listDelayMs = 300; // keep the listing on screen past the progress throttle
    const seen: string[] = [];
    const r = await runSet(drive, spec, { onProgress: (p) => seen.push(p.current) });
    expect(r.ok).toBe(true);
    expect(seen.some((c) => /reading Drive folder "[^"]*\/graph" \(1,000 items so far\)/.test(c))).toBe(true);
    const summary = catalog.listedSummary().find((s) => s.setId === spec.setId);
    expect(summary?.count).toBeGreaterThanOrEqual(1);
    expect(summary?.lastRel).toMatch(/\/graph$/);
  });

  it('a listed folder is not listed again to find (or create) a subfolder, nor for CLI-era rows', async () => {
    const t = Date.now() - 3_600_000;
    const spec = makeSet('backup');
    for (let i = 0; i < 30; i++) {
      write(`big/f${i}.jpg`, `p${i}`, t);
      drive.putFile(remote(spec, `big/f${i}.jpg`), `p${i}`, t);
    }
    drive.putFile(remote(spec, 'big/sub/old.jpg'), 'o', t); // a subfolder already on Drive
    write('big/new1.jpg', 'new one', t);
    // A CLI-era row (no node uid, no digest) for a file the listing will see.
    write('big/cli.jpg', 'cli', t);
    drive.putFile(remote(spec, 'big/cli.jpg'), 'cli', t);
    const cliRel = remote(spec, 'big/cli.jpg');
    catalog.upsertFile(spec.setId, cliRel, 3, t, null, 1, null);
    const r1 = await runSet(drive, spec); // lists "big" once (new1.jpg goes into it)
    expect(r1.ok).toBe(true);
    expect(catalog.getFile(spec.setId, cliRel)?.nodeUid).toBe(drive.at(remote(spec, 'big/cli.jpg'))!.uid); // remembered

    const bigUid = drive.at(remote(spec, 'big'))!.uid;
    let listedBig = 0;
    const orig = drive.children.bind(drive);
    drive.children = (uid: string) => {
      if (uid === bigUid) listedBig++;
      return orig(uid);
    };
    write('big/sub/fresh.jpg', 'fresh', t); // into the subfolder that exists on Drive
    write('big/other/x.jpg', 'x', t); // into a subfolder that does not
    write('big/cli.jpg', 'cli', t + 60_000); // same size, other mtime: compare digests
    const subUid = drive.at(remote(spec, 'big/sub'))!.uid;
    const r2 = await runSet(drive, spec);
    expect(r2.ok).toBe(true);
    expect(listedBig).toBe(0);
    expect(drive.at(remote(spec, 'big/sub/fresh.jpg'))?.parentUid).toBe(subUid); // no second "sub"
    expect(drive.at(remote(spec, 'big/other/x.jpg'))?.kind).toBe('file');
    expect(drive.at(remote(spec, 'big/cli.jpg'))?.revisions).toHaveLength(1); // same content: no upload
  });

  it('never adopts hidden files when the set excludes them', async () => {
    const t = Date.now() - 3_600_000;
    const spec = makeSet('backup');
    write('d/.hidden', 'h', t);
    write('d/visible.txt', 'v', t);
    drive.putFile(remote(spec, 'd/.hidden'), 'h', t);
    drive.putFile(remote(spec, 'd/other.txt'), 'o', t);
    write('d/other.txt', 'o', t);
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(catalog.getFile(spec.setId, remote(spec, 'd/.hidden'))).toBeUndefined();
  });
});

describe('many empty folders (a photo library\'s internals) do not stall the scan', () => {
  it('creates them in parallel, each exactly once, reports progress, and an unchanged re-run creates none', async () => {
    for (let i = 0; i < 60; i++) fs.mkdirSync(path.join(src, `lib/private/c${i % 6}/e${i}`), { recursive: true });
    write('zz/after.txt', 'scanned after the empty folders');
    const spec = makeSet('mirror');
    let active = 0;
    let peak = 0;
    const made = new Map<string, number>();
    const orig = drive.createFolder.bind(drive);
    let maxQueued = 0;
    drive.createFolder = async (parentUid: string, name: string) => {
      active++;
      peak = Math.max(peak, active);
      const act = engineActivity().find((a) => a.setId === spec.setId) as { emptyFoldersQueued?: number } | undefined;
      maxQueued = Math.max(maxQueued, act?.emptyFoldersQueued ?? 0);
      await new Promise((r) => setTimeout(r, 15)); // a real create takes ~300 ms
      try {
        const n = await orig(parentUid, name);
        made.set(`${parentUid}/${name}`, (made.get(`${parentUid}/${name}`) ?? 0) + 1);
        return n;
      } finally {
        active--;
      }
    };
    let foldersAtUpload = -1;
    const origUp = drive.uploadNew.bind(drive);
    drive.uploadNew = (async (...a: Parameters<FakeDrive['uploadNew']>) => {
      foldersAtUpload = made.size;
      return origUp(...a);
    }) as FakeDrive['uploadNew'];
    const seen: string[] = [];
    const r = await runSet(drive, spec, { onProgress: (p) => seen.push(p.current) });
    expect(r.ok).toBe(true);
    expect(r.newCount).toBe(1);
    expect(peak).toBeGreaterThan(1); // not one request after the other
    // The scan went on to the file while the folders were still being created.
    expect(foldersAtUpload).toBeGreaterThanOrEqual(0);
    expect(foldersAtUpload).toBeLessThan(30);
    expect([...made.values()].every((c) => c === 1)).toBe(true); // shared parents created once
    for (let i = 0; i < 60; i++) expect(drive.at(remote(spec, `lib/private/c${i % 6}/e${i}`))?.kind).toBe('folder');
    expect(seen.some((c) => /\d+ empty folders created/.test(c))).toBe(true);
    expect(maxQueued).toBeGreaterThan(0); // /api/diagnostics shows the backlog
    expect(engineActivity().find((a) => a.setId === spec.setId)).toBeUndefined(); // gone after the run
    drive.reset();
    const r2 = await runSet(drive, spec);
    expect(r2.ok).toBe(true);
    expect(drive.calls.createFolder).toBe(0);
  });

  it('parallel uploads into one new folder create that folder once', async () => {
    for (let i = 0; i < 20; i++) write(`fresh/deep/f${i}.txt`, `n${i}`);
    const spec = makeSet('backup');
    const orig = drive.createFolder.bind(drive);
    const names: string[] = [];
    drive.createFolder = async (parentUid: string, name: string) => {
      names.push(name);
      await new Promise((r) => setTimeout(r, 10));
      return orig(parentUid, name);
    };
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(names.filter((x) => x === 'fresh')).toHaveLength(1);
    expect(names.filter((x) => x === 'deep')).toHaveLength(1);
  });
});

describe('one listing per existing Drive folder, even with parallel uploads into it', () => {
  it('parallel new files in a folder that already exists on Drive share a single listing', async () => {
    const spec = makeSet('backup');
    for (let i = 0; i < 40; i++) write(`dir/f${i}.txt`, `n${i}`);
    drive.mkdirp(remote(spec, 'dir'));
    for (let i = 0; i < 200; i++) drive.putFile(remote(spec, `dir/old${i}.txt`), 'x');
    drive.listDelayMs = 30; // a slow listing overlaps with the next parallel upload
    drive.reset();
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(r.newCount).toBe(40);
    // root + target + set folder + source chain + 'dir' — but 'dir' exactly once.
    expect(drive.calls.children).toBeLessThanOrEqual(6);
  });
});

describe("Proton's per-folder item limit (200300): continuation folders", () => {
  const names = (spec: RunSpec, rel: string) =>
    [...drive.nodes.values()].filter((n) => n.parentUid === drive.at(remote(spec, rel))?.uid && !n.trashed).map((n) => n.name).sort();

  it('puts what does not fit into "<folder> · part N" next to it; nothing is skipped; re-runs are no-ops', async () => {
    for (let i = 0; i < 30; i++) write(`big/f${String(i).padStart(2, '0')}.bin`, `b${i}`);
    for (let i = 0; i < 3; i++) write(`small/f${i}.bin`, `s${i}`);
    const spec = makeSet('mirror');
    drive.maxChildren = 10;
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(r.failedCount).toBe(0);
    expect(r.newCount).toBe(33);
    expect(names(spec, '')).toEqual(['big', 'big · part 2', 'big · part 3', 'small']);
    expect(drive.at(remote(spec, 'big · part 3'))!.uid).toBeTruthy();
    const total = ['big', 'big · part 2', 'big · part 3'].reduce((n, d) => n + names(spec, d).length, 0);
    expect(total).toBe(30);

    drive.reset();
    const r2 = await runSet(drive, spec);
    expect(r2.unchangedCount).toBe(33);
    expect(drive.calls.uploadNew + drive.calls.createFolder + drive.calls.trash).toBe(0);

    // A changed file that lives in part 3 becomes a revision of that node.
    const inPart3 = names(spec, 'big · part 3')[0];
    const node = drive.at(remote(spec, `big · part 3/${inPart3}`))!;
    write(`big/${inPart3}`, 'changed!', Date.now() + 5000);
    const r3 = await runSet(drive, spec);
    expect(r3.changedCount).toBe(1);
    expect(node.revisions).toHaveLength(2);
  });

  it('a subfolder of a full folder is created in the current part', async () => {
    for (let i = 0; i < 10; i++) write(`big/f${i}.bin`, `b${i}`);
    write('big/sub/inner.txt', 'i');
    const spec = makeSet('backup');
    drive.maxChildren = 10;
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    const where = ['big', 'big · part 2'].find((d) => names(spec, d).includes('sub'));
    expect(where).toBeDefined();
    expect(drive.at(remote(spec, `${where}/sub/inner.txt`))).toBeDefined();
  });

  it('mirror trashes files inside parts and a removed folder together with its parts; parts are never "foreign"', async () => {
    setMirrorSafetyConfig({ enabled: false, deleteSafetyPct: 0.3 });
    for (let i = 0; i < 25; i++) write(`big/f${String(i).padStart(2, '0')}.bin`, `b${i}`);
    write('keep.txt', 'k');
    const spec = makeSet('mirror');
    drive.maxChildren = 10;
    await runSet(drive, spec);
    const inPart2 = names(spec, 'big · part 2')[0];
    fs.rmSync(path.join(src, 'big', inPart2));
    const preview = await previewSet(drive, spec);
    const r = await runSet(drive, spec);
    expect(r.deletedCount).toBe(1);
    expect(preview.wouldDeleteCount).toBe(1);
    expect(drive.at(remote(spec, `big · part 2/${inPart2}`))).toBeUndefined();

    fs.rmSync(path.join(src, 'big'), { recursive: true });
    const r2 = await runSet(drive, spec);
    expect(r2.ok).toBe(true);
    expect(names(spec, '')).toEqual(['keep.txt']);
  });

  it('rediscovers parts by name when the index is lost — no duplicate parts', async () => {
    for (let i = 0; i < 25; i++) write(`big/f${String(i).padStart(2, '0')}.bin`, `b${i}`);
    const spec = makeSet('backup');
    drive.maxChildren = 10;
    await runSet(drive, spec);
    getDb().exec('DELETE FROM drive_parts');
    for (let i = 0; i < 8; i++) write(`big/new${i}.bin`, `n${i}`);
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    // part 3 had 5 free slots, the other 3 went to a new part 4; parts 2/3 were reused.
    expect(names(spec, '').filter((n) => n.startsWith('big'))).toEqual(['big', 'big · part 2', 'big · part 3', 'big · part 4']);
  });

  it('verify sees files in parts and does not count parts as foreign', async () => {
    for (let i = 0; i < 15; i++) write(`big/f${i}.bin`, `b${i}`);
    const spec = makeSet('backup');
    drive.maxChildren = 10;
    await runSet(drive, spec);
    const v = await verifySet(drive, spec);
    expect(v.repaired).toBe(0);
    expect(v.foreign).toBe(0);
    expect(v.checked).toBe(15);
  });

  it('nesting too deep stays a clear, permanent skip', async () => {
    write('a/b.txt', 'x');
    const spec = makeSet('backup');
    drive.faults.push({ op: 'createFolder', code: 'TOO_DEEP', times: 99, match: (nm) => nm === 'a' });
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(false);
    expect(r.failedFiles[0].reason).toMatch(/nested deeper/);
  });
});

describe('crash between Drive confirmation and the SQLite commit', () => {
  it('a NEW file Drive already has is adopted, not uploaded twice', async () => {
    write('a.txt', 'payload');
    const spec = makeSet('backup');
    drive.faults.push({ op: 'uploadNew', code: 'NETWORK', times: 1, afterCommit: true });
    const r1 = await runSet(drive, { ...spec });
    // The upload was retried after the "crash": the retry found the committed file.
    expect(r1.adoptedCount + r1.newCount).toBeGreaterThan(0);
    expect(drive.at(remote(spec, 'a.txt'))!.revisions).toHaveLength(1);
  });

  it('a REVISION Drive already has is adopted on restart (no second revision)', async () => {
    write('a.txt', 'v1');
    const spec = makeSet('backup');
    await runSet(drive, spec);
    const node = drive.at(remote(spec, 'a.txt'))!;
    write('a.txt', 'v2-longer', Date.now() + 5000);
    // Simulate: Drive committed v2, then the process died before recording it.
    drive.faults.push({ op: 'uploadRevision', code: 'UNAUTHENTICATED', times: 1, afterCommit: true });
    await runSet(drive, spec);
    expect(node.revisions).toHaveLength(2);
    expect(catalog.getFile(spec.setId, remote(spec, 'a.txt'))?.size).toBe(2); // still v1 in the catalog
    drive.reset();
    const r = await runSet(drive, spec);
    expect(r.adoptedCount).toBe(1);
    expect(drive.calls.uploadRevision).toBe(0);
    expect(node.revisions).toHaveLength(2);
    expect(catalog.getFile(spec.setId, remote(spec, 'a.txt'))?.size).toBe(9);
  });

  it('an upload that failed before confirmation is never recorded as backed up', async () => {
    write('a.txt', 'x');
    const spec = makeSet('backup');
    drive.faults.push({ op: 'uploadNew', code: 'QUOTA', times: 1 });
    const r = await runSet(drive, spec);
    expect(r.failedCount).toBe(1);
    expect(catalog.getFile(spec.setId, remote(spec, 'a.txt'))).toBeUndefined();
  });
});

describe('mirror safety', () => {
  async function seeded(files = 10) {
    for (let i = 0; i < files; i++) write(`f${i}.txt`, `c${i}`);
    const spec = makeSet('mirror');
    await runSet(drive, spec);
    return spec;
  }

  it('an offline NAS share (empty mountpoint) never deletes; an intentionally emptied folder does after confirmation', async () => {
    setMirrorSafetyConfig({ enabled: false, deleteSafetyPct: 0.3 });
    const spec = await seeded();
    for (const f of fs.readdirSync(src)) fs.rmSync(path.join(src, f), { recursive: true });
    const r = await runSet(drive, spec);
    expect(r.deletionSkipped).toMatch(/is empty/);
    expect(drive.calls.trash).toBe(0);
    const r2 = await runSet(drive, { ...spec, confirmSources: true });
    expect(r2.deletedCount).toBe(10);
  });

  it('an offline share stays blocked on EVERY run until confirmed (its state never becomes the reference)', async () => {
    setMirrorSafetyConfig({ enabled: false, deleteSafetyPct: 0.3 });
    const spec = await seeded(5);
    backupSets.setSourceMarks(spec.setId, { [src]: { mounted: true, nonEmpty: true } });
    for (const f of fs.readdirSync(src)) fs.rmSync(path.join(src, f), { recursive: true }); // empty mountpoint left behind
    for (let i = 0; i < 3; i++) {
      const r = await runSet(drive, spec);
      expect(r.deletionSkipped).toMatch(/no longer a mounted share/);
    }
    expect(drive.calls.trash).toBe(0);
    expect(backupSets.get(spec.setId)!.sourceMarks[src]).toEqual({ mounted: true, nonEmpty: true });
  });

  it('a source that was a mount and is now a plain directory blocks deletion', async () => {
    setMirrorSafetyConfig({ enabled: false, deleteSafetyPct: 0.3 });
    const spec = await seeded(3);
    backupSets.setSourceMarks(spec.setId, { [src]: { mounted: true, nonEmpty: true } });
    fs.rmSync(path.join(src, 'f0.txt'));
    const r = await runSet(drive, spec);
    expect(r.deletionSkipped).toMatch(/no longer a mounted share/);
    expect(drive.calls.trash).toBe(0);
  });

  it('a missing source is reported as a failure, never as a successful "0 uploaded" backup', async () => {
    write('a.txt', 'a');
    const spec = makeSet('backup');
    await runSet(drive, spec);
    fs.rmSync(src, { recursive: true });
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/missing on disk/);
  });

  it('a missing source path blocks deletion', async () => {
    const spec = await seeded(3);
    fs.rmSync(src, { recursive: true });
    const r = await runSet(drive, spec);
    expect(r.deletionSkipped).toMatch(/missing/);
  });

  it('never trashes a folder that holds files the backup did not upload', async () => {
    write('keep/k.txt', 'k');
    write('gone/a.txt', 'a');
    write('gone/b.txt', 'b');
    for (let i = 0; i < 10; i++) write(`x${i}.txt`, 'x');
    const spec = makeSet('mirror');
    await runSet(drive, spec);
    drive.putFile(remote(spec, 'gone/foreign.pdf'), 'not ours');
    fs.rmSync(path.join(src, 'gone'), { recursive: true });
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    const folder = drive.at(remote(spec, 'gone'));
    expect(folder?.trashed).toBe(false);
    expect(drive.at(remote(spec, 'gone/foreign.pdf'))).toBeDefined();
    expect(drive.at(remote(spec, 'gone/a.txt'))).toBeUndefined(); // ours: trashed
  });

  it('a file replaced on Drive by someone else is not trashed', async () => {
    const spec = await seeded(10);
    const node = drive.at(remote(spec, 'f1.txt'))!;
    node.name = 'renamed-by-user.txt';
    drive.putFile(remote(spec, 'f1.txt'), 'someone else');
    fs.rmSync(path.join(src, 'f1.txt'));
    await runSet(drive, spec);
    expect(drive.at(remote(spec, 'f1.txt'))?.trashed).toBe(false);
    expect(node.trashed).toBe(false);
  });

  it('an upload failure blocks deletion; a network error on Drive is never "not found"', async () => {
    const spec = await seeded(10);
    fs.rmSync(path.join(src, 'f2.txt'));
    write('new.txt', 'n');
    drive.faults.push({ op: 'uploadNew', code: 'QUOTA', times: 5 });
    const r = await runSet(drive, spec);
    expect(r.deletionSkipped).toMatch(/failed to upload/);
    expect(drive.calls.trash).toBe(0);

    drive.faults.push({ op: 'getNode', code: 'NETWORK', times: 99 });
    await expect(runSet(drive, spec)).rejects.toThrow(/NETWORK/);
    expect(drive.at(remote(spec, 'f2.txt'))?.trashed).toBe(false);
  });

  it('dry run predicts exactly what the live run deletes (hidden files, empty folders, excludes)', async () => {
    write('.hidden', 'h');
    write('a/a.txt', 'a');
    write('b/b.txt', 'b');
    write('skip.tmp', 't');
    for (let i = 0; i < 12; i++) write(`z${i}.txt`, 'z');
    const spec = makeSet('mirror', { includeHidden: true });
    await runSet(drive, spec);
    // Now: hidden files off, a/ emptied (dir stays), b/ deleted, skip.tmp excluded.
    fs.rmSync(path.join(src, 'a/a.txt'));
    fs.rmSync(path.join(src, 'b'), { recursive: true });
    const next = { ...spec, includeHidden: false, excludes: ['*.tmp'] };
    const preview = await previewSet(drive, next);
    const live = await runSet(drive, next);
    expect(live.deletedCount).toBe(preview.wouldDeleteCount);
    expect(preview.wouldDelete.sort()).toEqual([remote(spec, '.hidden'), remote(spec, 'a/a.txt'), remote(spec, 'b')].sort());
    expect(drive.at(remote(spec, 'a'))?.trashed).toBe(false); // empty folder kept
    expect(drive.at(remote(spec, 'skip.tmp'))?.trashed).toBe(false); // excluded = kept
  });
});

describe('target folder identity', () => {
  it('follows a rename of the set folder; refuses a deleted or re-created one', async () => {
    write('a.txt', 'a');
    const spec = makeSet('backup');
    await runSet(drive, spec);
    const folder = drive.at(spec.subfolder)!;
    folder.name = 'Renamed';
    write('b.txt', 'b');
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(backupSets.get(spec.setId)!.targetSubfolder).toBe('Renamed');
    expect(drive.at('Renamed/' + remote({ ...spec, subfolder: 'Renamed' }, 'b.txt').split('/').slice(1).join('/'))).toBeDefined();

    folder.trashed = true;
    drive.mkdirp('Renamed'); // same name, different folder
    drive.reset();
    const r2 = await runSet(drive, { ...spec, subfolder: 'Renamed' });
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/trash/);
    expect(drive.calls.uploadNew + drive.calls.uploadRevision).toBe(0);
  });

  it('after following a rename, excludes still apply in the same run', async () => {
    write('keep.txt', 'k');
    // A PATH pattern (relative to the sources root): basename patterns would hide the bug.
    const spec = makeSet('backup', { excludes: [`src${n}/cache/**`] });
    await runSet(drive, spec);
    drive.at(spec.subfolder)!.name = 'Moved';
    write('cache/junk.tmp', 'j');
    write('new.txt', 'n');
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(r.newCount).toBe(1);
    const base = remote({ ...spec, subfolder: 'Moved' }, '').replace(/\/$/, '');
    expect(drive.at(base + '/cache/junk.tmp')).toBeUndefined();
    expect(drive.at(base + '/new.txt')).toBeDefined();
  });

  it('a missing target folder stops the run without uploading', async () => {
    write('a.txt', 'a');
    const spec = makeSet('backup', { targetPath: '/my-files/Nope' });
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no longer exists/);
    expect(drive.calls.uploadNew).toBe(0);
  });
});

describe('failures inside a batch', () => {
  it('one bad file does not stop the others; transient errors are retried once each', async () => {
    for (let i = 0; i < 5; i++) write(`f${i}.txt`, `c${i}`);
    const spec = makeSet('backup');
    drive.faults.push({ op: 'uploadNew', code: 'INVALID_NAME', times: 1, match: (nm) => nm === 'f3.txt' });
    drive.faults.push({ op: 'uploadNew', code: 'RATE_LIMITED', times: 1, match: (nm) => nm === 'f1.txt' });
    const r = await runSet(drive, spec);
    expect(r.failedFiles).toEqual([expect.objectContaining({ rel: expect.stringMatching(/f3\.txt$/) })]);
    expect(r.failedCount).toBe(1);
    expect(drive.at(remote(spec, 'f1.txt'))?.revisions).toHaveLength(1);
  });

  it('session expiry stops the run with the reconnect message', async () => {
    for (let i = 0; i < 4; i++) write(`f${i}.txt`, `c${i}`);
    const spec = makeSet('mirror');
    drive.faults.push({ op: 'uploadNew', code: 'UNAUTHENTICATED', times: 99 });
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/session expired/);
    expect(drive.calls.trash).toBe(0);
  });
});

describe('cancel and pause', () => {
  it('stops promptly: confirmed files are recorded, the rest is not, nothing is deleted', async () => {
    for (let i = 0; i < 30; i++) write(`f${i}.txt`, `c${i}`);
    const spec = makeSet('mirror');
    let uploads = 0;
    const orig = drive.uploadNew.bind(drive);
    drive.uploadNew = async (...a: Parameters<FakeDrive['uploadNew']>) => {
      uploads++;
      return orig(...a);
    };
    const r = await runSet(drive, spec, { shouldCancel: () => uploads >= 5 });
    expect(r.cancelled).toBe(true);
    expect(r.ok).toBe(false);
    expect(drive.calls.trash).toBe(0);
    const recorded = catalog.countFiles(spec.setId);
    expect(recorded).toBeGreaterThanOrEqual(5);
    expect(recorded).toBeLessThan(30);
    // Resume: only the rest is uploaded.
    drive.reset();
    const r2 = await runSet(drive, spec);
    expect(r2.ok).toBe(true);
    expect(drive.calls.uploadNew).toBe(30 - recorded);
  });
});

describe('add mode', () => {
  it('never updates; a different file already on Drive is left alone, and Backup later uploads it', async () => {
    write('a.txt', 'local');
    const spec = makeSet('add');
    drive.putFile(remote(spec, 'a.txt'), 'remote!');
    const r = await runSet(drive, spec);
    expect(r.ok).toBe(true);
    expect(drive.at(remote(spec, 'a.txt'))!.revisions).toHaveLength(1);
    const r2 = await runSet(drive, { ...spec, mode: 'backup' });
    expect(r2.changedCount).toBe(1);
    expect(drive.at(remote(spec, 'a.txt'))!.revisions.at(-1)!.content.toString()).toBe('local');
  });
});

describe('content verification', () => {
  it('same size + same mtime change is invisible to the delta, found by a content verify', async () => {
    const t = Date.now() - 50_000;
    write('a.txt', 'AAAA', t);
    const spec = makeSet('backup');
    await runSet(drive, spec);
    write('a.txt', 'BBBB', t); // same size, same mtime
    drive.reset();
    const r = await runSet(drive, spec);
    expect(r.unchangedCount).toBe(1);
    expect(drive.calls.uploadRevision).toBe(0);
    const v = await verifySet(drive, spec, { content: true });
    expect(v.contentMismatches).toBe(1);
    const r2 = await runSet(drive, spec);
    expect(r2.newCount + r2.changedCount).toBe(1);
    expect(drive.at(remote(spec, 'a.txt'))!.revisions.at(-1)!.content.toString()).toBe('BBBB');
  });

  it('verify fills node ids for CLI-era rows and drops rows Drive no longer has', async () => {
    write('a.txt', 'a');
    write('b.txt', 'b');
    const spec = makeSet('backup');
    await runSet(drive, spec);
    getDb().exec(`UPDATE backup_catalog SET node_uid = NULL WHERE set_id = '${spec.setId}'`);
    drive.at(remote(spec, 'b.txt'))!.trashed = true;
    const v = await verifySet(drive, spec);
    expect(v.repaired).toBe(1);
    expect(catalog.getFile(spec.setId, remote(spec, 'a.txt'))?.nodeUid).toBe(drive.at(remote(spec, 'a.txt'))!.uid);
  });
});

describe('topMost', () => {
  it('keeps only entries without an ancestor in the list', () => {
    expect(topMost([{ rel: 'a' }, { rel: 'a/b' }, { rel: 'c/d' }, { rel: 'c/d/e' }]).map((x) => x.rel)).toEqual(['a', 'c/d']);
  });
});
