import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { backupSets, meta } from './db';
import {
  driveErrorCode,
  DriveError,
  type AccountInfo,
  type DriveService,
  type LoginStatus,
  type ProtonRuntime,
  type RemoteNode,
  type Versions,
} from './proton/types';

/**
 * App-side facade over the Proton SDK runtime (src/server/proton/runtime.ts,
 * bundled to dist-proton/runtime.mjs). Replaces the CLI wrapper: there are no
 * child processes anymore — every Drive operation is an in-process SDK call that
 * shares one session, one request limiter and one metadata cache.
 *
 * Responsibilities here:
 *  - load the runtime exactly once per process (globalThis singleton),
 *  - Proton paths ("/my-files/a/b") → nodes, with a small folder-name index that
 *    Drive events and every write through this module invalidate,
 *  - session/auth state for the UI, and the ACCOUNT BINDING that stops a backup
 *    from ever writing into a different Proton account than the one its sets
 *    were created with.
 */

export const PROTON_ROOT = '/my-files';
export const SESSION_DIR = process.env.PROTON_DRIVE_CACHE_DIR || '/data/proton';
const RUNTIME_PATH = process.env.PROTON_RUNTIME || path.join(process.cwd(), 'dist-proton/runtime.mjs');
export const APP_VERSION = process.env.APP_RELEASE || readPackageVersion();
const APP_BUILD = (process.env.APP_VERSION || '').slice(0, 12);

function readPackageVersion(): string {
  for (const p of [path.join(process.cwd(), 'package.json'), path.join(__dirname, '../../package.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (typeof v === 'string') return v;
    } catch {
      /* next candidate */
    }
  }
  return '0.0.0';
}

type G = {
  __pdRuntime?: Promise<ProtonRuntime>;
  __pdRuntimeOverride?: ProtonRuntime;
  __pdNameIndex?: Map<string, { at: number; byName: Map<string, RemoteNode> }>;
  __pdAuth?: { authed: boolean; at: number; account: AccountInfo | null; hadSession?: boolean };
  __pdBusy?: { v: number };
};
const g = globalThis as unknown as G;

/** Tests inject a fake runtime (see test/fake-drive.ts). */
export function setRuntimeForTests(rt: ProtonRuntime | undefined): void {
  g.__pdRuntimeOverride = rt;
  g.__pdNameIndex?.clear();
  g.__pdAuth = undefined;
}

export async function runtime(): Promise<ProtonRuntime> {
  if (g.__pdRuntimeOverride) return g.__pdRuntimeOverride;
  if (!g.__pdRuntime) {
    g.__pdRuntime = (async () => {
      const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(RUNTIME_PATH).href)) as {
        createRuntime: (o: unknown) => Promise<ProtonRuntime>;
      };
      let clientUid = meta.get('proton.clientUid');
      if (!clientUid) {
        clientUid = `proton_drive_backup-${randomUUID()}`;
        meta.set('proton.clientUid', clientUid);
      }
      const rt = await mod.createRuntime({
        sessionDir: SESSION_DIR,
        appVersion: APP_VERSION,
        appBuild: APP_BUILD,
        baseUrl: process.env.PROTON_DRIVE_BASE_URL || undefined,
        clientUid,
        log: (level: string, msg: string) => {
          if (level === 'debug' && !process.env.PDB_DEBUG) return;
          (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[proton] ${msg}`);
        },
      });
      rt.onFolderChanged((uid) => nameIndex().delete(uid));
      rt.onSessionLost(() => markSessionLost());
      if (rt.hasSession()) rt.startEvents().catch(() => {});
      return rt;
    })();
    g.__pdRuntime.catch(() => (g.__pdRuntime = undefined)); // retry on next call
  }
  return g.__pdRuntime;
}

export async function drive(): Promise<DriveService> {
  return (await runtime()).drive;
}

export async function versions(): Promise<Versions> {
  return (await runtime()).versions;
}

/* ------------------------------------------------------------------ */
/* Busy flag (a run is in progress)                                    */
/* ------------------------------------------------------------------ */

const busy = g.__pdBusy ?? (g.__pdBusy = { v: 0 });
export function setBackupRunning(v: boolean) {
  busy.v = Math.max(0, busy.v + (v ? 1 : -1));
}
export const uploadsBusy = () => busy.v > 0;

/* ------------------------------------------------------------------ */
/* Paths and the folder-name index                                     */
/* ------------------------------------------------------------------ */

/** Normalise a user-supplied Proton path to an absolute /my-files path. */
export function normalizeProtonPath(p: string): string {
  if (!p || p === '/' || p === PROTON_ROOT) return PROTON_ROOT;
  if (p === PROTON_ROOT || p.startsWith(PROTON_ROOT + '/')) return p.replace(/\/+$/, '');
  return `${PROTON_ROOT}/${p.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function segments(p: string): string[] {
  const n = normalizeProtonPath(p);
  return n === PROTON_ROOT ? [] : n.slice(PROTON_ROOT.length + 1).split('/');
}

const INDEX_TTL = 5 * 60_000;
const INDEX_MAX = 500;
function nameIndex() {
  return g.__pdNameIndex ?? (g.__pdNameIndex = new Map());
}

export function invalidateFolder(uid?: string | null) {
  if (uid) nameIndex().delete(uid);
  else nameIndex().clear();
}

/** All children of a folder by name (cached, invalidated by Drive events and our writes). */
export async function childrenByName(folderUid: string, fresh = false): Promise<Map<string, RemoteNode>> {
  const idx = nameIndex();
  const hit = idx.get(folderUid);
  if (!fresh && hit && Date.now() - hit.at < INDEX_TTL) {
    idx.delete(folderUid);
    idx.set(folderUid, hit); // LRU touch
    return hit.byName;
  }
  const d = await drive();
  const byName = new Map<string, RemoteNode>();
  for await (const n of d.children(folderUid)) if (n.name !== null) byName.set(n.name, n);
  idx.set(folderUid, { at: Date.now(), byName });
  while (idx.size > INDEX_MAX) idx.delete(idx.keys().next().value!);
  return byName;
}

/**
 * Resolve a Proton path to its node. Returns null ONLY when Drive confirmed that a
 * path segment does not exist; any other failure throws (never "missing" on a blip).
 */
export async function resolvePath(p: string, fresh = false): Promise<RemoteNode | null> {
  const d = await drive();
  let node = await d.root();
  for (const seg of segments(p)) {
    let child = (await childrenByName(node.uid, fresh)).get(seg);
    if (!child && !fresh) child = (await childrenByName(node.uid, true)).get(seg); // cache may predate a create
    if (!child) return null;
    node = child;
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Operations used by the API routes                                   */
/* ------------------------------------------------------------------ */

export interface DriveEntry {
  uid: string;
  name: string;
  type: 'file' | 'folder';
  mediaType?: string;
  size?: number;
  mtimeMs?: number;
  sha1?: string;
}

export type OpResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string | null };
const fail = (e: unknown): { ok: false; error: string; code: string | null } => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e),
  code: driveErrorCode(e),
});

export async function listDrive(p: string, fresh = false): Promise<OpResult<DriveEntry[]>> {
  try {
    const folder = await resolvePath(p, fresh);
    if (!folder) return { ok: false, error: 'not found', code: 'NOT_FOUND' };
    const kids = await childrenByName(folder.uid, fresh);
    const entries: DriveEntry[] = [];
    for (const n of kids.values()) {
      entries.push({
        uid: n.uid,
        name: n.name ?? '',
        type: n.kind,
        mediaType: n.mediaType ?? undefined,
        size: n.size ?? undefined,
        mtimeMs: n.mtimeMs ?? undefined,
        sha1: n.sha1 ?? undefined,
      });
    }
    return { ok: true, data: entries };
  } catch (e) {
    return fail(e);
  }
}

export async function createFolder(parentPath: string, name: string): Promise<OpResult<RemoteNode>> {
  try {
    const parent = await resolvePath(parentPath);
    if (!parent) return { ok: false, error: 'parent not found', code: 'NOT_FOUND' };
    const node = await (await drive()).createFolder(parent.uid, name);
    invalidateFolder(parent.uid);
    return { ok: true, data: node };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Trash the node at `p` — only after re-reading it fresh and confirming it is
 * still the item at that path (same parent, same name, not already trashed).
 */
export async function trashDrive(p: string, expectUid?: string): Promise<OpResult<true>> {
  try {
    if (segments(p).length === 0) return { ok: false, error: 'refusing to trash My files', code: 'INVALID_NAME' };
    const node = await resolvePath(p, true);
    if (!node) return { ok: false, error: 'not found', code: 'NOT_FOUND' };
    if (expectUid && node.uid !== expectUid) return { ok: false, error: 'the item changed on Drive; refresh and retry', code: 'NAME_CONFLICT' };
    const [r] = await (await drive()).trash([node.uid]);
    invalidateFolder(node.parentUid);
    return r?.ok ? { ok: true, data: true } : { ok: false, error: r?.error || 'trash failed', code: r?.code ?? null };
  } catch (e) {
    return fail(e);
  }
}

export async function renameDrive(p: string, newName: string): Promise<OpResult<RemoteNode>> {
  try {
    const node = await resolvePath(p, true);
    if (!node) return { ok: false, error: 'not found', code: 'NOT_FOUND' };
    const out = await (await drive()).rename(node.uid, newName);
    invalidateFolder(node.parentUid);
    return { ok: true, data: out };
  } catch (e) {
    return fail(e);
  }
}

/** true = exists, false = Drive confirmed it does not, null = could not tell. */
export async function drivePathExists(p: string): Promise<boolean | null> {
  try {
    return (await resolvePath(p, true)) !== null;
  } catch {
    return null;
  }
}

/** Map any Drive error to a user-safe message (never echoes raw server text). */
export function cleanDriveError(e: unknown, code?: string | null): string {
  const c = code ?? driveErrorCode(e);
  switch (c) {
    case 'UNAUTHENTICATED':
      return 'Proton session expired - reconnect to continue.';
    case 'ACCOUNT_MISMATCH':
      return 'Signed in to a different Proton account than your backup sets use.';
    case 'NOT_FOUND':
      return 'Not found on Drive.';
    case 'NAME_CONFLICT':
      return 'An item with that name already exists.';
    case 'RATE_LIMITED':
      return 'Proton is rate-limiting requests - try again in a minute.';
    case 'NETWORK':
      return 'Network error talking to Proton - try again.';
    case 'QUOTA':
      return 'Drive storage is full.';
    case 'INVALID_NAME':
      return 'That name is not allowed on Drive.';
    default:
      return 'The Drive operation failed.';
  }
}

/* ------------------------------------------------------------------ */
/* Session, login and account binding                                  */
/* ------------------------------------------------------------------ */

const AUTH_TTL = 60_000;
const FORCE_MIN_AGE = 20_000;

function markSessionLost() {
  g.__pdAuth = { authed: false, at: Date.now(), account: null };
  // A taken-over session that Proton rejected never proved the account: whoever
  // signs in next must be confirmed.
  if (!meta.get('account.userId')) meta.set('account.origin', 'login');
}

/**
 * Is a usable Proton session present? Cheap: answers from a short cache and only
 * contacts Proton when stale or forced. A transient failure keeps the last known
 * answer — a network blip never logs the UI out.
 */
export async function isAuthenticated(force = false): Promise<boolean> {
  const rt = await runtime();
  if (!rt.hasSession()) {
    g.__pdAuth = { authed: false, at: Date.now(), account: null, hadSession: false };
    return false;
  }
  const c = g.__pdAuth?.hadSession === rt.hasSession() ? g.__pdAuth : undefined; // a login just finished → recheck
  // Forced checks (every open tab re-verifies once a minute) are coalesced: at most
  // one Proton request per FORCE_MIN_AGE no matter how many tabs poll.
  if (c && Date.now() - c.at < (force ? FORCE_MIN_AGE : AUTH_TTL)) return c.authed;
  try {
    const acc = await rt.account(force);
    g.__pdAuth = { authed: !!acc, at: Date.now(), account: acc, hadSession: true };
    if (acc) noteAccount(acc);
    return !!acc;
  } catch {
    return c?.authed ?? rt.hasSession();
  }
}

export async function currentAccount(): Promise<AccountInfo | null> {
  if (!(await isAuthenticated())) return null;
  return g.__pdAuth?.account ?? (await (await runtime()).account());
}

export async function loginStart(): Promise<LoginStatus> {
  if (!meta.get('account.userId')) meta.set('account.origin', 'login');
  g.__pdAuth = undefined;
  return (await runtime()).login.start();
}

export async function loginStatus(): Promise<LoginStatus> {
  return (await runtime()).login.status();
}

export async function logout(): Promise<void> {
  const rt = await runtime();
  await rt.logout();
  g.__pdAuth = { authed: false, at: Date.now(), account: null };
  invalidateFolder();
}

/**
 * ACCOUNT BINDING. The first account a backup set ran against is recorded; a
 * write into any other account is refused until the user explicitly confirms.
 *
 *  - CLI-era install upgraded in place: the session file it already had IS the
 *    account its sets were created with → bound automatically on first contact
 *    (`origin=takeover`). No prompt, scheduled runs continue.
 *  - Fresh login on an install that already has backup sets but no binding
 *    (e.g. the old session could not be taken over) → writes wait for one
 *    confirmation in the UI showing the signed-in address and every target.
 *  - Fresh install without sets → bound on first login.
 *  - Signed in to a DIFFERENT account than the bound one → writes are refused
 *    until the user signs back in or explicitly rebinds (which resets every set's
 *    catalog and Drive folder binding, because node ids belong to the old account).
 */
export type BindingState = 'none' | 'ok' | 'confirm' | 'mismatch';

/**
 * Decide once, at the first start of this release, where the session came from.
 * Only a session that a CLI-era installation already had (and that is still
 * accepted) counts as a takeover; any later login needs a confirmation if sets exist.
 */
export function initAccountOrigin(sessionFileExists: boolean) {
  if (meta.get('account.origin') || meta.get('account.userId')) return;
  const takeover = !!meta.get('upgrade.fromCli') && sessionFileExists;
  if (takeover) preserveCliSession();
  meta.set('account.origin', takeover ? 'takeover' : 'login');
}

/**
 * Keep the CLI's session exactly as the 0.x release left it, once. If Proton
 * rejected that session under this app's identification, the account module
 * removes auth-session.json — and a rollback to 0.x would then need a new sign-in.
 * With this copy it does not (docs/UPGRADE.md). Never used by this release.
 */
function preserveCliSession() {
  const src = path.join(SESSION_DIR, 'auth-session.json');
  const dst = path.join(SESSION_DIR, 'auth-session.pre-sdk.json');
  try {
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dst, 0o600);
  } catch (e) {
    console.warn('[upgrade] could not keep a copy of the CLI session:', e instanceof Error ? e.message : e);
  }
}

function noteAccount(acc: AccountInfo) {
  const bound = meta.get('account.userId');
  if (bound) return;
  const origin = meta.get('account.origin');
  const hasSets = backupSets.all().length > 0;
  if (origin === 'takeover' || !hasSets) {
    meta.set('account.userId', acc.userId);
    meta.set('account.email', acc.email ?? '');
    meta.set('account.boundAt', String(Date.now()));
    meta.set('account.origin', origin === 'takeover' ? 'takeover' : 'first-login');
  }
}

export function bindingState(acc: AccountInfo | null): BindingState {
  if (!acc) return 'none';
  const bound = meta.get('account.userId');
  if (!bound) return backupSets.all().length > 0 ? 'confirm' : 'ok';
  return bound === acc.userId ? 'ok' : 'mismatch';
}

export function boundEmail(): string | null {
  return meta.get('account.email') || null;
}

/** User confirmed the signed-in account for all sets. `rebind` = switch accounts. */
export function confirmBinding(acc: AccountInfo, rebind: boolean): void {
  const bound = meta.get('account.userId');
  if (bound && bound !== acc.userId && !rebind) throw new DriveError('ACCOUNT_MISMATCH', 'different account');
  if (bound && bound !== acc.userId && rebind) backupSets.resetAllBindings();
  meta.set('account.userId', acc.userId);
  meta.set('account.email', acc.email ?? '');
  meta.set('account.boundAt', String(Date.now()));
  meta.set('account.origin', bound && bound !== acc.userId ? 'rebind' : 'confirmed');
}

/**
 * The single gate every WRITING job passes: logged in, and the account is the
 * bound one. Returns null when writing is allowed, else a user-facing reason.
 */
export async function writeGate(): Promise<string | null> {
  if (!(await isAuthenticated())) return 'Proton session expired — reconnect to Proton Drive to resume backups. Your backup set is unchanged.';
  const acc = await currentAccount();
  const st = bindingState(acc);
  if (st === 'confirm') return 'Confirm the Proton account for your backup sets (banner at the top) before backups write to Drive.';
  if (st === 'mismatch') return `Signed in as ${acc?.email ?? 'another account'}, but these backup sets belong to ${boundEmail() ?? 'a different account'}. Nothing was written.`;
  return null;
}
