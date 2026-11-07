/**
 * The contract between the app and the Proton SDK boundary.
 *
 * Everything on the app side (engine, routes, tests) depends only on these
 * types. The SDK itself, the crypto package and the vendored account module are
 * imported in exactly one place, src/server/proton/runtime.ts, which is bundled
 * into one server-side module (see scripts/build-proton.mjs). An SDK update that
 * changes behaviour therefore surfaces as a type or contract-test failure here,
 * not somewhere inside the engine.
 */

export type NodeKind = 'file' | 'folder';

export interface RemoteNode {
  uid: string;
  parentUid: string | null;
  /** Decrypted name; null if Drive returned a name we could not decrypt. */
  name: string | null;
  kind: NodeKind;
  /** Claimed (plaintext) size of the active revision, files only. */
  size: number | null;
  /** Claimed modification time of the active revision (ms), files only. */
  mtimeMs: number | null;
  /** Claimed SHA-1 of the active revision, files only. */
  sha1: string | null;
  mediaType: string | null;
  trashed: boolean;
}

/**
 * Error codes the engine acts on. Only NOT_FOUND means "Drive confirmed this
 * does not exist". Every other code — including network, auth, rate limit and
 * decryption failures — must be treated as "unknown", never as "missing".
 */
export type DriveErrorCode =
  | 'NOT_FOUND'
  | 'NAME_CONFLICT'
  | 'UNAUTHENTICATED'
  | 'ACCOUNT_MISMATCH'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'INTEGRITY'
  | 'DECRYPTION'
  | 'QUOTA'
  /** The Drive folder holds the maximum number of items Proton allows (200300). */
  | 'FOLDER_FULL'
  /** Folder nesting deeper than Proton allows (200301). */
  | 'TOO_DEEP'
  /** File larger than the account's plan allows (200003). */
  | 'FILE_TOO_LARGE'
  | 'INVALID_NAME'
  | 'CANCELLED'
  | 'SERVER'
  | 'UNKNOWN';

export class DriveError extends Error {
  readonly code: DriveErrorCode;
  /** For NAME_CONFLICT: the uid of the node that already has the name. */
  readonly existingUid?: string;
  /** For NAME_CONFLICT: true if the existing node is an unfinished upload (draft). */
  readonly existingIsDraft?: boolean;
  constructor(code: DriveErrorCode, message: string, extra: { existingUid?: string; existingIsDraft?: boolean; cause?: unknown } = {}) {
    super(message, { cause: extra.cause });
    this.name = 'DriveError';
    this.code = code;
    this.existingUid = extra.existingUid;
    this.existingIsDraft = extra.existingIsDraft;
  }
}

/** Works across module instances (no instanceof across the bundle boundary). */
export function driveErrorCode(e: unknown): DriveErrorCode | null {
  const x = e as { name?: string; code?: unknown } | null;
  return x && x.name === 'DriveError' && typeof x.code === 'string' ? (x.code as DriveErrorCode) : null;
}

export interface LocalFile {
  abs: string;
  size: number;
  mtimeMs: number;
}

export interface UploadOptions {
  mediaType: string;
  /** Generate Drive thumbnails for images (decodes the image once). */
  thumbnails: boolean;
  signal?: AbortSignal;
  /** Called with the cumulative number of bytes read from disk. */
  onProgress?: (bytes: number) => void;
  /** Awaited before every chunk read from disk (upload speed limit). */
  throttle?: (bytes: number) => Promise<void>;
  /** Replace an unfinished upload (draft) another client left under this name. */
  overrideDraft?: boolean;
}

export interface UploadResult {
  nodeUid: string;
  revisionUid: string;
  /** SHA-1 of exactly the bytes that were uploaded (computed in the same read). */
  sha1: string;
}

/** The Drive operations the app uses. Implemented by the SDK runtime and by test fakes. */
export interface DriveService {
  /** The "My files" root folder. */
  root(): Promise<RemoteNode>;
  /** Fresh node metadata, or null if Drive confirms the node does not exist. */
  getNode(uid: string): Promise<RemoteNode | null>;
  /** Children of a folder (not trashed), streamed page by page. */
  children(folderUid: string, signal?: AbortSignal): AsyncIterable<RemoteNode>;
  /** Create a folder; if a FOLDER with that name already exists, return it. */
  createFolder(parentUid: string, name: string): Promise<RemoteNode>;
  /** Upload a new file. Throws DriveError NAME_CONFLICT (with existingUid) if the name is taken. */
  uploadNew(parentUid: string, name: string, file: LocalFile, opts: UploadOptions): Promise<UploadResult>;
  /** Upload a new revision of an existing file node. */
  uploadRevision(nodeUid: string, file: LocalFile, opts: UploadOptions): Promise<UploadResult>;
  /** Move nodes to the Drive trash (restorable). */
  trash(uids: string[]): Promise<{ uid: string; ok: boolean; error?: string; code?: DriveErrorCode }[]>;
  rename(uid: string, newName: string): Promise<RemoteNode>;
  /** Revisions of a file node, newest first (restore/diagnostics; not used by runs). */
  revisions?(uid: string): Promise<{ uid: string; active: boolean; size: number | null; sha1: string | null; created: number }[]>;
  /** Download one revision to a local file, verified by the SDK. Returns bytes written. */
  download?(revisionUid: string, destPath: string): Promise<number>;
}

export interface AccountInfo {
  userId: string;
  email: string | null;
  displayName: string | null;
  maxSpace: number;
  usedSpace: number;
  driveUsed: number;
}

export type LoginState = 'idle' | 'awaiting' | 'authenticated' | 'failed';

export interface LoginStatus {
  state: LoginState;
  signInUrl?: string;
  error?: string;
}

export interface Versions {
  /** App release version (package.json). */
  app: string;
  /** x-pm-appversion sent to Proton. */
  appVersionHeader: string;
  /** @protontech/drive-sdk version (from the package itself). */
  sdk: string;
  /** Upstream tag and commit the vendored account module comes from. */
  sdkTag: string;
  sdkCommit: string;
  crypto: string;
}

/** What the SDK told us about required/suggested client updates (x-pm-drive-*requirements headers). */
export interface UpdateNotice {
  kind: 'required' | 'suggested' | 'unsupported-feature';
  message: string;
  at: number;
}

export interface ProtonRuntime {
  versions: Versions;
  drive: DriveService;
  /** True if a session is loaded (does not contact Proton). */
  hasSession(): boolean;
  /**
   * Verify the session against Proton (refreshing tokens if needed). Returns the
   * account, null if Proton definitively rejected the session, and throws on
   * transient failures (network, 5xx) so callers never mistake a blip for a logout.
   */
  account(force?: boolean): Promise<AccountInfo | null>;
  login: {
    start(): Promise<LoginStatus>;
    status(): LoginStatus;
    cancel(): void;
  };
  logout(): Promise<void>;
  /** Drop cached Drive metadata (entities + our name index). Never touches the session. */
  clearCaches(): Promise<void>;
  /** Subscribe to Drive events once logged in (keeps caches coherent). */
  startEvents(): Promise<void>;
  /** Stop event polling while idle (and drop the entity cache it kept coherent). */
  pauseEvents(): Promise<void>;
  cacheStats(): { entities: number; crypto: number; events: boolean };
  /** Called by the runtime when Drive reports changes under a folder (cache invalidation). */
  onFolderChanged(cb: (folderUid: string) => void): void;
  /** Called whenever the runtime concludes the session is gone (refresh rejected). */
  onSessionLost(cb: () => void): void;
  notices(): UpdateNotice[];
  /** Proton API requests since start, by method + endpoint (ids masked). */
  requestStats(): { total: number; byEndpoint: Record<string, number> };
  dispose(): Promise<void>;
}

export interface RuntimeOptions {
  /** Directory holding auth-session.json (PROTON_DRIVE_CACHE_DIR, default /data/proton). */
  sessionDir: string;
  appVersion: string;
  /** Short git sha of the app build, appended as SemVer build metadata. */
  appBuild?: string;
  baseUrl?: string;
  /** Persistent per-installation client uid (stored by the app). */
  clientUid: string;
  /** Max concurrent thumbnail decodes (memory bound). */
  thumbnailConcurrency?: number;
  /** LRU sizes of the SDK caches (decrypted node metadata / keys). */
  entityCacheSize?: number;
  cryptoCacheSize?: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}
