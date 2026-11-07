// Shared "remote Drive" for the upgrade acceptance test: one JSON file that the
// fake proton-drive CLI (used by the published CLI-era image) and the fake SDK
// runtime (used by the new image) both read and write. Only metadata is kept
// (name, parent, revisions with size/mtime/sha1); every operation is appended to
// ops.log so the test can assert "zero uploads, zero revisions, zero deletions".
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DIR = process.env.FAKE_DRIVE_DIR || '/fake-drive';
const FILE = path.join(DIR, 'state.json');
const OPS = path.join(DIR, 'ops.log');

export function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { nodes: { root: { uid: 'root', parentUid: null, name: 'my-files', kind: 'folder', revisions: [], trashed: false } } };
  }
}

export function save(st) {
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, FILE);
}

export function op(who, kind, detail) {
  fs.appendFileSync(OPS, JSON.stringify({ t: Date.now(), who, kind, ...detail }) + '\n');
}

export function child(st, parentUid, name) {
  return Object.values(st.nodes).find((n) => n.parentUid === parentUid && n.name === name && !n.trashed);
}

export function add(st, parentUid, name, kind) {
  const n = { uid: randomUUID(), parentUid, name, kind, revisions: [], trashed: false };
  st.nodes[n.uid] = n;
  return n;
}

/** "/my-files/a/b" → node (or undefined). */
export function resolve(st, p) {
  let cur = st.nodes.root;
  for (const seg of p.replace(/^\/my-files\/?/, '').split('/').filter(Boolean)) {
    cur = child(st, cur.uid, seg);
    if (!cur) return undefined;
  }
  return cur;
}
