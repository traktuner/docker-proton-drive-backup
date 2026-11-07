import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { DriveError, type DriveErrorCode, type DriveService, type LocalFile, type RemoteNode, type UploadOptions, type UploadResult } from '@/server/proton/types';

/**
 * In-memory Proton Drive implementing the app's DriveService contract, with the
 * semantics the engine relies on (name conflicts with existingUid, revisions,
 * trash) plus fault injection and request counters. Uploads really read the local
 * file, so "bytes read" and SHA-1 are measured, not assumed.
 */
interface FNode {
  uid: string;
  parentUid: string | null;
  name: string;
  kind: 'file' | 'folder';
  revisions: { uid: string; sha1: string; size: number; mtimeMs: number; content: Buffer }[];
  trashed: boolean;
}

export type Op = 'root' | 'getNode' | 'children' | 'createFolder' | 'uploadNew' | 'uploadRevision' | 'trash' | 'rename';

export class FakeDrive implements DriveService {
  nodes = new Map<string, FNode>();
  rootUid = 'root';
  calls: Record<Op, number> = { root: 0, getNode: 0, children: 0, createFolder: 0, uploadNew: 0, uploadRevision: 0, trash: 0, rename: 0 };
  bytesRead = 0;
  /** Fail the next N calls of an op with a code (consumed in order). */
  faults: { op: Op; code: DriveErrorCode; times: number; afterCommit?: boolean; match?: (name: string) => boolean }[] = [];
  /** Proton's per-folder item limit (error 200300 → FOLDER_FULL); Infinity = off. */
  maxChildren = Infinity;

  private full(parentUid: string) {
    let n = 0;
    for (const x of this.nodes.values()) if (x.parentUid === parentUid && !x.trashed) n++;
    if (n >= this.maxChildren) throw new DriveError('FOLDER_FULL', 'Folder limit reached');
  }

  constructor() {
    this.nodes.set(this.rootUid, { uid: this.rootUid, parentUid: null, name: 'my-files', kind: 'folder', revisions: [], trashed: false });
  }

  reset() {
    for (const k of Object.keys(this.calls) as Op[]) this.calls[k] = 0;
    this.bytesRead = 0;
  }

  get revisionCount() {
    let n = 0;
    for (const x of this.nodes.values()) n += x.revisions.length;
    return n;
  }

  private fault(op: Op, name = '', afterCommit = false) {
    const f = this.faults.find((x) => x.op === op && !!x.afterCommit === afterCommit && (!x.match || x.match(name)));
    if (!f) return;
    if (--f.times <= 0) this.faults.splice(this.faults.indexOf(f), 1);
    throw new DriveError(f.code, `injected ${f.code} on ${op}`);
  }

  private view(n: FNode): RemoteNode {
    const rev = n.revisions[n.revisions.length - 1];
    return {
      uid: n.uid,
      parentUid: n.parentUid,
      name: n.name,
      kind: n.kind,
      size: n.kind === 'file' ? (rev?.size ?? null) : null,
      mtimeMs: n.kind === 'file' ? (rev?.mtimeMs ?? null) : null,
      sha1: n.kind === 'file' ? (rev?.sha1 ?? null) : null,
      mediaType: null,
      trashed: n.trashed,
    };
  }

  childNamed(parentUid: string, name: string): FNode | undefined {
    for (const n of this.nodes.values()) if (n.parentUid === parentUid && n.name === name && !n.trashed) return n;
    return undefined;
  }

  /** Test helper: path ("a/b/c") → node, below root. */
  at(path: string): FNode | undefined {
    let cur = this.nodes.get(this.rootUid)!;
    for (const seg of path.split('/').filter(Boolean)) {
      const next = this.childNamed(cur.uid, seg);
      if (!next) return undefined;
      cur = next;
    }
    return cur;
  }

  /** Test helper: create a folder chain / a file with content directly ("remote" state). */
  mkdirp(path: string): FNode {
    let cur = this.nodes.get(this.rootUid)!;
    for (const seg of path.split('/').filter(Boolean)) {
      cur = this.childNamed(cur.uid, seg) ?? this.add(cur.uid, seg, 'folder');
    }
    return cur;
  }

  putFile(path: string, content: Buffer | string, mtimeMs = Date.now()): FNode {
    const parts = path.split('/');
    const name = parts.pop()!;
    const parent = this.mkdirp(parts.join('/'));
    const buf = Buffer.from(content);
    const node = this.childNamed(parent.uid, name) ?? this.add(parent.uid, name, 'file');
    node.revisions.push({ uid: randomUUID(), sha1: createHash('sha1').update(buf).digest('hex'), size: buf.length, mtimeMs, content: buf });
    return node;
  }

  private add(parentUid: string, name: string, kind: 'file' | 'folder'): FNode {
    const n: FNode = { uid: randomUUID(), parentUid, name, kind, revisions: [], trashed: false };
    this.nodes.set(n.uid, n);
    return n;
  }

  async root() {
    this.calls.root++;
    this.fault('root');
    return this.view(this.nodes.get(this.rootUid)!);
  }

  async getNode(uid: string) {
    this.calls.getNode++;
    this.fault('getNode');
    const n = this.nodes.get(uid);
    return n ? this.view(n) : null;
  }

  async *children(folderUid: string) {
    this.calls.children++;
    this.fault('children');
    const p = this.nodes.get(folderUid);
    if (!p || p.kind !== 'folder') throw new DriveError('NOT_FOUND', 'folder not found');
    for (const n of [...this.nodes.values()]) if (n.parentUid === folderUid && !n.trashed) yield this.view(n);
  }

  async createFolder(parentUid: string, name: string) {
    this.calls.createFolder++;
    this.fault('createFolder', name);
    const p = this.nodes.get(parentUid);
    if (!p || p.trashed) throw new DriveError('NOT_FOUND', 'parent not found');
    const ex = this.childNamed(parentUid, name);
    if (ex) {
      if (ex.kind === 'folder') return this.view(ex);
      throw new DriveError('NAME_CONFLICT', 'exists', { existingUid: ex.uid });
    }
    return this.view(this.add(parentUid, name, 'folder'));
  }

  private async read(file: LocalFile, o: UploadOptions) {
    const buf = fs.readFileSync(file.abs);
    this.bytesRead += buf.length;
    if (o.throttle) await o.throttle(buf.length);
    o.onProgress?.(buf.length);
    if (buf.length !== file.size) throw new DriveError('INTEGRITY', 'size changed during upload');
    return buf;
  }

  async uploadNew(parentUid: string, name: string, file: LocalFile, o: UploadOptions): Promise<UploadResult> {
    this.calls.uploadNew++;
    this.fault('uploadNew', name);
    const p = this.nodes.get(parentUid);
    if (!p || p.trashed) throw new DriveError('NOT_FOUND', 'parent not found');
    const ex = this.childNamed(parentUid, name);
    if (ex) throw new DriveError('NAME_CONFLICT', 'exists', { existingUid: ex.uid });
    this.full(parentUid);
    const buf = await this.read(file, o);
    const n = this.add(parentUid, name, 'file');
    const sha1 = createHash('sha1').update(buf).digest('hex');
    const rev = { uid: randomUUID(), sha1, size: buf.length, mtimeMs: Math.round(file.mtimeMs), content: buf };
    n.revisions.push(rev);
    this.fault('uploadNew', name, true); // "Drive confirmed, then the client died"
    return { nodeUid: n.uid, revisionUid: rev.uid, sha1 };
  }

  async uploadRevision(nodeUid: string, file: LocalFile, o: UploadOptions): Promise<UploadResult> {
    this.calls.uploadRevision++;
    const n = this.nodes.get(nodeUid);
    this.fault('uploadRevision', n?.name ?? '');
    if (!n || n.trashed) throw new DriveError('NOT_FOUND', 'node not found');
    const buf = await this.read(file, o);
    const sha1 = createHash('sha1').update(buf).digest('hex');
    const rev = { uid: randomUUID(), sha1, size: buf.length, mtimeMs: Math.round(file.mtimeMs), content: buf };
    n.revisions.push(rev);
    this.fault('uploadRevision', n.name, true);
    return { nodeUid, revisionUid: rev.uid, sha1 };
  }

  async trash(uids: string[]) {
    this.calls.trash++;
    this.fault('trash');
    return uids.map((uid) => {
      const n = this.nodes.get(uid);
      if (!n) return { uid, ok: false, error: 'not found', code: 'NOT_FOUND' as const };
      n.trashed = true;
      return { uid, ok: true };
    });
  }

  async rename(uid: string, newName: string) {
    this.calls.rename++;
    const n = this.nodes.get(uid);
    if (!n) throw new DriveError('NOT_FOUND', 'not found');
    n.name = newName;
    return this.view(n);
  }
}
