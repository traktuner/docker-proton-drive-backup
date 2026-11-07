import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDrive } from '../../test/fake-drive';
import { backupSets, getDb, meta } from '@/server/db';
import { catalog } from '@/server/catalog';
import {
  bindingState,
  confirmBinding,
  currentAccount,
  initAccountOrigin,
  isAuthenticated,
  setRuntimeForTests,
  writeGate,
} from '@/server/drive';
import type { AccountInfo, ProtonRuntime } from '@/server/proton/types';

/** Minimal runtime: a session flag and an account the test switches. */
function fakeRuntime(state: { session: boolean; account: AccountInfo | null; fail?: boolean }): ProtonRuntime {
  return {
    versions: { app: 't', appVersionHeader: 't', sdk: 't', sdkTag: 't', sdkCommit: 't', crypto: 't' },
    drive: new FakeDrive(),
    hasSession: () => state.session,
    account: async () => {
      if (state.fail) throw Object.assign(new Error('offline'), { name: 'DriveError', code: 'NETWORK' });
      return state.session ? state.account : null;
    },
    login: { start: async () => ({ state: 'awaiting' }), status: () => ({ state: 'idle' }), cancel() {} },
    logout: async () => {
      state.session = false;
    },
    clearCaches: async () => {},
    startEvents: async () => {},
    onFolderChanged() {},
    onSessionLost() {},
    notices: () => [],
    dispose: async () => {},
  };
}
const A: AccountInfo = { userId: 'user-A', email: 'a@example.com', displayName: 'A', maxSpace: 1, usedSpace: 0, driveUsed: 0 };
const B: AccountInfo = { ...A, userId: 'user-B', email: 'b@example.com' };

beforeEach(() => {
  getDb().exec('DELETE FROM backup_sets; DELETE FROM backup_catalog; DELETE FROM app_meta;');
});

describe('account binding', () => {
  it('takes over the session of a CLI-era install without asking (and binds it)', async () => {
    backupSets.create({ name: 'S', sourcePaths: ['/x'], targetPath: '/' });
    meta.set('upgrade.fromCli', '1');
    initAccountOrigin(true);
    setRuntimeForTests(fakeRuntime({ session: true, account: A }));
    expect(await isAuthenticated(true)).toBe(true);
    expect(bindingState(await currentAccount())).toBe('ok');
    expect(meta.get('account.userId')).toBe('user-A');
    expect(await writeGate()).toBeNull();
  });

  it('a NEW sign-in on an install that has sets must be confirmed before anything is written', async () => {
    backupSets.create({ name: 'S', sourcePaths: ['/x'], targetPath: '/' });
    meta.set('upgrade.fromCli', '1');
    initAccountOrigin(false); // the old session was not there → not a takeover
    setRuntimeForTests(fakeRuntime({ session: true, account: A }));
    expect(bindingState(await currentAccount())).toBe('confirm');
    expect(await writeGate()).toMatch(/Confirm the Proton account/);
    confirmBinding(A, false);
    expect(await writeGate()).toBeNull();
  });

  it('a different account is refused; rebinding resets every catalog', async () => {
    const s = backupSets.create({ name: 'S', sourcePaths: ['/x'], targetPath: '/' });
    catalog.upsertFile(s.id, 'S/f', 1, 1, 'x', 1, 'node-1');
    backupSets.setFolderUid(s.id, 'folder-A');
    meta.set('account.userId', 'user-A');
    meta.set('account.email', 'a@example.com');
    setRuntimeForTests(fakeRuntime({ session: true, account: B }));
    expect(bindingState(await currentAccount())).toBe('mismatch');
    expect(await writeGate()).toMatch(/belong to a@example.com/);
    expect(() => confirmBinding(B, false)).toThrow();
    confirmBinding(B, true);
    expect(meta.get('account.userId')).toBe('user-B');
    expect(catalog.count(s.id)).toBe(0);
    expect(backupSets.get(s.id)!.folderUid).toBeNull();
  });

  it('a network blip never reports a logout', async () => {
    const st = { session: true, account: A, fail: false };
    setRuntimeForTests(fakeRuntime(st));
    meta.set('account.userId', 'user-A');
    expect(await isAuthenticated(true)).toBe(true);
    st.fail = true;
    expect(await isAuthenticated(true)).toBe(true); // cached / last known
  });

  it('no session → writes are refused with the reconnect message', async () => {
    setRuntimeForTests(fakeRuntime({ session: false, account: null }));
    expect(await writeGate()).toMatch(/session expired/);
  });
});
