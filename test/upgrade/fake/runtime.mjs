// Fake Proton SDK runtime for the NEW image in the upgrade acceptance test.
// Implements the same ProtonRuntime contract as src/server/proton/runtime.ts
// (selected via PROTON_RUNTIME), against the shared fake Drive the CLI-era image
// wrote. The session file is the real auth-session.json; the first account check
// "refreshes" the tokens (rotates at-N → at-N+1) exactly like the SDK's refresh
// hook would, so the rollback test sees a session that changed under the new image.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { load as rawLoad, save, op, child, add, withLock } from './state.mjs';
const load = () => withLock(rawLoad);

class DriveError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DriveError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export async function createRuntime(opts) {
  const file = path.join(opts.sessionDir, 'auth-session.json');
  const readSession = () => {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      return s?.session?.accessToken && s.userKeyPassword ? s : null;
    } catch {
      return null;
    }
  };
  const writeSession = (s) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  let refreshed = false;
  const view = (n) => {
    const r = n.revisions[n.revisions.length - 1];
    return {
      uid: n.uid,
      parentUid: n.parentUid,
      name: n.name,
      kind: n.kind,
      size: n.kind === 'file' ? (r?.size ?? null) : null,
      mtimeMs: n.kind === 'file' ? (r?.mtimeMs ?? null) : null,
      sha1: n.kind === 'file' ? (r?.sha1 ?? null) : null,
      mediaType: null,
      trashed: !!n.trashed,
    };
  };
  const need = () => {
    if (!readSession()) throw new DriveError('UNAUTHENTICATED', 'Proton login required');
  };
  // Every mutation is one synchronous read-modify-write under the state lock, so
  // concurrent uploads of this process (and nothing else) can never lose updates.
  const mutate = (fn) => withLock(() => { const st = rawLoad(); const out = fn(st); save(st); return out; });
  const putRevision = (n, f, o) => {
    const buf = fs.readFileSync(f.abs);
    o.onProgress?.(buf.length);
    const sha1 = createHash('sha1').update(buf).digest('hex');
    n.revisions.push({ size: buf.length, mtimeMs: Math.round(f.mtimeMs), sha1 });
    return { nodeUid: n.uid, revisionUid: `${n.uid}:${n.revisions.length}`, sha1 };
  };

  const drive = {
    async root() {
      need();
      return view(load().nodes.root);
    },
    async getNode(uid) {
      need();
      const n = load().nodes[uid];
      op('sdk', 'getNode', { uid });
      return n ? view(n) : null;
    },
    async *children(uid) {
      need();
      const st = load();
      op('sdk', 'children', { uid });
      for (const n of Object.values(st.nodes)) if (n.parentUid === uid && !n.trashed) yield view(n);
    },
    async createFolder(parentUid, name) {
      need();
      return mutate((st) => {
        const ex = child(st, parentUid, name);
        if (ex) {
          if (ex.kind === 'folder') return view(ex);
          throw new DriveError('NAME_CONFLICT', 'exists', { existingUid: ex.uid });
        }
        const n = add(st, parentUid, name, 'folder');
        op('sdk', 'createFolder', { name });
        return view(n);
      });
    },
    async uploadNew(parentUid, name, f, o) {
      need();
      return mutate((st) => {
        const ex = child(st, parentUid, name);
        if (ex) throw new DriveError('NAME_CONFLICT', 'exists', { existingUid: ex.uid });
        const n = add(st, parentUid, name, 'file');
        op('sdk', 'uploadNew', { uid: n.uid, name });
        return putRevision(n, f, o);
      });
    },
    async uploadRevision(uid, f, o) {
      need();
      return mutate((st) => {
        const n = st.nodes[uid];
        if (!n || n.trashed) throw new DriveError('NOT_FOUND', 'not found');
        op('sdk', 'uploadRevision', { uid, name: n.name });
        return putRevision(n, f, o);
      });
    },
    async trash(uids) {
      need();
      return mutate((st) =>
        uids.map((uid) => {
          const n = st.nodes[uid];
          if (!n) return { uid, ok: false, error: 'not found', code: 'NOT_FOUND' };
          n.trashed = true;
          op('sdk', 'trash', { uid, name: n.name });
          return { uid, ok: true };
        }),
      );
    },
    async rename(uid, name) {
      need();
      return mutate((st) => {
        st.nodes[uid].name = name;
        return view(st.nodes[uid]);
      });
    },
  };

  return {
    versions: { app: opts.appVersion, appVersionHeader: 'external-drive-proton_drive_backup@fake', sdk: 'fake', sdkTag: 'fake', sdkCommit: 'fake', crypto: 'fake' },
    drive,
    hasSession: () => !!readSession(),
    async account() {
      const s = readSession();
      if (!s) return null;
      if (!refreshed && process.env.FAKE_REFRESH !== '0') {
        // What the SDK's refresh hook does on a 401: new access AND refresh token,
        // persisted in place (cachePassword and other fields preserved).
        refreshed = true;
        const n = Number(s.session.accessToken.split('-')[1]) + 1;
        writeSession({ ...s, session: { ...s.session, accessToken: `at-${n}`, refreshToken: `rt-${n}` } });
        op('sdk', 'refresh', { to: n });
      }
      return { userId: 'user-1', email: 'test@example.com', displayName: 'Test', maxSpace: 1e12, usedSpace: 1, driveUsed: 1 };
    },
    login: {
      async start() {
        setTimeout(() => {
          writeSession({ cachePassword: 'cp2', userKeyPassword: 'ukp', session: { uid: 'sess-2', accessToken: 'at-0', refreshToken: 'rt-0' } });
        }, 300);
        return { state: 'awaiting', signInUrl: 'https://account.proton.me/desktop/login#fake' };
      },
      status: () => ({ state: readSession() ? 'authenticated' : 'idle' }),
      cancel() {},
    },
    async logout() {
      fs.rmSync(file, { force: true });
    },
    async clearCaches() {},
    async startEvents() {},
    onFolderChanged() {},
    onSessionLost() {},
    notices: () => [],
    async dispose() {},
  };
}
