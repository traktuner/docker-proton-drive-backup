/**
 * The Proton Drive SDK boundary.
 *
 * This is the ONLY module that imports @protontech/drive-sdk, @protontech/crypto
 * and the vendored (incubating, unpublished) account module. scripts/build-proton.mjs
 * bundles it — together with those packages — into one ES module that the server
 * loads exactly once per process (src/server/drive.ts). That gives:
 *   - one CryptoProxy endpoint, one session, one request limiter per process
 *     (no duplicate module instances across Next.js route bundles);
 *   - one small, typed surface (./types.ts) the rest of the app depends on.
 *
 * Upstream specifics handled here and nowhere else (see ./PATCHES.md):
 *   - `openpgp/lightweight` is only exported for browsers; the bundle aliases it to
 *     the Node build of `openpgp` (the official CLI ships the same change as a
 *     source patch to @protontech/crypto).
 *   - @protontech/drive-sdk has no `exports` map, so the EXIF helper is imported
 *     from its dist path.
 */
import fs from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { CryptoProxy, updateServerTime } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp } from '@protontech/crypto/srp';
import {
  MemoryCache,
  NodeType,
  NullFeatureFlagProvider,
  OpenPGPCryptoWithCryptoProxy,
  ProtonDriveClient,
  VERSION as SDK_VERSION,
  type NodeEntity,
  type Thumbnail,
  ThumbnailType,
  type EventSubscription,
} from '@protontech/drive-sdk';
import { generateAdditionalNodeMetadata } from '@protontech/drive-sdk/dist/additionalNodeMetadata';
import { ApiClient, initAccount, type SessionCredentials, type SessionInfo } from './vendor/account/index';
import UPSTREAM from './vendor/UPSTREAM.json';
import { SessionFile } from './session-store';
import {
  DriveError,
  type AccountInfo,
  type DriveErrorCode,
  type DriveService,
  type LocalFile,
  type LoginStatus,
  type ProtonRuntime,
  type RemoteNode,
  type RuntimeOptions,
  type UpdateNotice,
  type UploadOptions,
  type UploadResult,
} from './types';

/** Third-party identification required by Proton (see the SDK README). */
export function appVersionHeader(appVersion: string, build?: string): string {
  const semver = /^\d+\.\d+\.\d+$/.test(appVersion) ? appVersion : '0.0.0';
  const channel = semver.startsWith('0.') ? 'beta' : 'stable';
  const suffix = build && /^[0-9a-z]+$/i.test(build) ? `+${build.slice(0, 12)}` : '';
  return `external-drive-proton_drive_backup@${semver}-${channel}${suffix}`;
}

/* ------------------------------------------------------------------------ */
/* Credentials: the account module's SessionCredentials over the CLI file     */
/* ------------------------------------------------------------------------ */

class Credentials implements SessionCredentials {
  private info?: SessionInfo;
  private keyPassword?: string;
  private telemetry?: boolean;
  private cachePassword?: string;
  private readonly cbs = new Set<() => void>();
  lost?: () => void;

  constructor(private readonly file: SessionFile) {}

  get uid() {
    return this.info?.uid;
  }
  get accessToken() {
    return this.info?.accessToken;
  }
  get refreshToken() {
    return this.info?.refreshToken;
  }
  on(_e: 'sessionInfoChanged', cb: () => void) {
    this.cbs.add(cb);
  }
  isLoggedIn() {
    return !!this.info && !!this.keyPassword;
  }
  isTelemetryEnabled() {
    return false; // this app never sends telemetry
  }
  getUserKeyPassword() {
    return this.keyPassword;
  }
  async load() {
    const s = this.file.load();
    if (!s) return;
    this.info = { uid: s.session.uid, accessToken: s.session.accessToken, refreshToken: s.session.refreshToken ?? undefined };
    this.keyPassword = s.userKeyPassword;
    this.telemetry = s.telemetryEnabled;
    this.cachePassword = s.cachePassword;
    this.emit();
  }
  async setUserKeyPassword(p: string) {
    this.keyPassword = p;
    this.persist();
    this.emit();
  }
  async setSessionInfo(i: SessionInfo) {
    this.info = i;
    this.persist();
    this.emit();
  }
  async setTelemetryEnabled(e: boolean) {
    this.telemetry = e;
    this.persist();
  }
  async signOut() {
    const had = this.isLoggedIn();
    this.info = undefined;
    this.keyPassword = undefined;
    this.telemetry = undefined;
    this.file.remove();
    this.emit();
    if (had) this.lost?.();
  }
  private persist() {
    if (!this.info || !this.keyPassword) return;
    this.file.save({
      userKeyPassword: this.keyPassword,
      session: { uid: this.info.uid, accessToken: this.info.accessToken, refreshToken: this.info.refreshToken },
      ...(this.cachePassword !== undefined && { cachePassword: this.cachePassword }),
      ...(this.telemetry !== undefined && { telemetryEnabled: this.telemetry }),
    });
  }
  private emit() {
    for (const cb of this.cbs) cb();
  }
}

/* ------------------------------------------------------------------------ */
/* Error mapping                                                             */
/* ------------------------------------------------------------------------ */

function mapError(e: unknown, fallback: DriveErrorCode = 'UNKNOWN'): DriveError {
  if ((e as { name?: string })?.name === 'DriveError') return e as DriveError;
  const err = e as { name?: string; message?: string; code?: number; statusCode?: number; existingNodeUid?: string; isUnfinishedUpload?: boolean };
  const msg = String(err?.message ?? e).slice(0, 300);
  const name = err?.name ?? '';
  if (name === 'NodeWithSameNameExistsValidationError')
    return new DriveError('NAME_CONFLICT', msg, { existingUid: err.existingNodeUid, existingIsDraft: !!err.isUnfinishedUpload, cause: e });
  if (name === 'NotFoundAPIError' || err?.code === 2501) return new DriveError('NOT_FOUND', msg, { cause: e });
  if (name === 'AbortError') return new DriveError('CANCELLED', msg, { cause: e });
  if (name === 'RateLimitedError' || err?.statusCode === 429) return new DriveError('RATE_LIMITED', msg, { cause: e });
  if (name === 'ConnectionError') return new DriveError('NETWORK', msg, { cause: e });
  if (name === 'DecryptionError') return new DriveError('DECRYPTION', msg, { cause: e });
  if (name === 'IntegrityError') return new DriveError('INTEGRITY', msg, { cause: e });
  if (err?.statusCode === 401 || /not logged in|unauthori[sz]ed|session/i.test(name)) return new DriveError('UNAUTHENTICATED', msg, { cause: e });
  if (/quota|storage (is )?full|not enough space|insufficient/i.test(msg)) return new DriveError('QUOTA', msg, { cause: e });
  if (name === 'ValidationError' && /name/i.test(msg)) return new DriveError('INVALID_NAME', msg, { cause: e });
  if (name === 'ServerError' || (err?.statusCode ?? 0) >= 500) return new DriveError('SERVER', msg, { cause: e });
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network/i.test(msg)) return new DriveError('NETWORK', msg, { cause: e });
  return new DriveError(fallback, msg, { cause: e });
}

function toRemote(n: NodeEntity): RemoteNode {
  const rev = n.activeRevision;
  const isFile = n.type !== NodeType.Folder && n.type !== NodeType.Album;
  return {
    uid: n.uid,
    parentUid: n.parentUid ?? null,
    name: n.name.ok ? n.name.value : null,
    kind: isFile ? 'file' : 'folder',
    size: isFile ? (rev?.claimedSize ?? null) : null,
    mtimeMs: isFile ? (rev?.claimedModificationTime?.getTime() ?? null) : null,
    sha1: isFile ? (rev?.claimedDigests?.sha1 ?? null) : null,
    mediaType: n.mediaType ?? null,
    trashed: !!n.trashTime,
  };
}

/* ------------------------------------------------------------------------ */
/* Local file streaming (single read per upload, bounded buffering)          */
/* ------------------------------------------------------------------------ */

const READ_CHUNK = 1 << 20; // 1 MiB; the SDK encrypts in 4 MiB blocks

function fileStream(abs: string, opts: UploadOptions, hash: Hash): ReadableStream<Uint8Array> {
  const rs = fs.createReadStream(abs, { highWaterMark: READ_CHUNK });
  const it = rs[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let read = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        const { value, done } = await it.next();
        if (done) {
          ctrl.close();
          return;
        }
        if (opts.throttle) await opts.throttle(value.length);
        read += value.length;
        hash.update(value);
        opts.onProgress?.(read);
        ctrl.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      },
      cancel() {
        rs.destroy();
      },
    },
    { highWaterMark: 0 }, // pull-driven: nothing is read ahead of what the SDK asks for
  );
}

/** EXIF lives in the file header for every format the SDK parses; never read whole images into RAM. */
const EXIF_HEADER_BYTES = 256 * 1024;

async function headerBlob(abs: string, size: number, mtimeMs: number) {
  const fh = await fs.promises.open(abs, 'r');
  try {
    const len = Math.min(size, EXIF_HEADER_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return { lastModified: mtimeMs, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + len) as ArrayBuffer };
  } finally {
    await fh.close();
  }
}

const THUMB_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff', 'image/webp']);

/** Same sizes/limits as the official CLI (cli/src/commands/fileSystem/generateThumbnails.ts). */
async function makeThumbnails(abs: string, mediaType: string): Promise<Thumbnail[]> {
  if (!THUMB_TYPES.has(mediaType)) return [];
  const sharp = (await import('sharp')).default;
  // limitInputPixels bounds decode memory for hostile/huge images (≈ 268 MP default).
  const img = sharp(abs, { failOn: 'none', limitInputPixels: 0x3fff * 0x3fff, sequentialRead: true }).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) return [];
  const fit = async (side: number, maxBytes: number) => {
    for (let q = 90; q > 0; q -= 10) {
      const out = await img.clone().resize(side, side, { fit: 'inside', withoutEnlargement: true }).webp({ quality: q }).toBuffer();
      if (out.length <= maxBytes) return out;
    }
    return undefined;
  };
  const t1 = await fit(512, 64 * 1024 - 512);
  if (!t1) return [];
  const out: Thumbnail[] = [{ type: ThumbnailType.Type1, thumbnail: new Uint8Array(t1) }];
  const isJpegOrWebp = /^image\/(jpe?g|webp)$/.test(mediaType);
  if (Math.max(meta.width, meta.height) > 1920 || !isJpegOrWebp) {
    const t2 = await fit(1920, 1024 * 1024 - 512);
    if (t2) out.push({ type: ThumbnailType.Type2, thumbnail: new Uint8Array(t2) });
  }
  return out;
}

/** Tiny counting semaphore. */
function semaphore(n: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((r) => waiters.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

/* ------------------------------------------------------------------------ */
/* Runtime                                                                   */
/* ------------------------------------------------------------------------ */

let cryptoReady = false;

export async function createRuntime(opts: RuntimeOptions): Promise<ProtonRuntime> {
  const log = opts.log ?? (() => {});
  const baseUrl = opts.baseUrl || 'drive-api.proton.me';
  const header = appVersionHeader(opts.appVersion, opts.appBuild);
  const notices: UpdateNotice[] = [];
  const noticeOnce = (kind: UpdateNotice['kind'], message: string) => {
    if (notices.some((n) => n.message === message)) return;
    notices.push({ kind, message, at: Date.now() });
    log('warn', message);
  };

  if (!cryptoReady) {
    // Process-wide singleton in @protontech/crypto: initialise exactly once.
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    cryptoReady = true;
  }

  const sessionFile = new SessionFile(opts.sessionDir);
  const credentials = new Credentials(sessionFile);
  const lostCbs = new Set<() => void>();
  credentials.lost = () => lostCbs.forEach((cb) => cb());

  const logger = {
    debug: (m: string) => log('debug', m),
    info: (m: string) => log('info', m),
    warn: (m: string) => log('warn', m),
    error: (m: string, e?: unknown) => log('error', `${m}${e instanceof Error ? `: ${e.message}` : ''}`),
  };

  const apiClient = new ApiClient({
    baseUrl,
    appVersion: header,
    credentials,
    logger,
    headers: { 'x-pm-drive-sdk-version': SDK_VERSION },
    afterResponseHooks: [
      (_req, _o, res) => {
        const d = res.headers.get('x-pm-date') ?? res.headers.get('date');
        const t = d ? new Date(d) : null;
        if (t && !Number.isNaN(t.getTime())) updateServerTime(t);
        const platform = res.headers.get('x-pm-drive-platform-requirements');
        if (platform) {
          const kv = Object.fromEntries(platform.trim().split(/\s+/).map((p) => p.split('=') as [string, string]));
          const newer = (v?: string) => !!v && cmpSemver(SDK_VERSION, v) < 0;
          if (newer(kv.required)) noticeOnce('required', `Proton requires Drive SDK ${kv.required} or newer (this build uses ${SDK_VERSION}).`);
          else if (newer(kv.suggested)) noticeOnce('suggested', `Proton recommends Drive SDK ${kv.suggested} or newer (this build uses ${SDK_VERSION}).`);
        }
      },
    ],
  });

  const { auth, addresses } = await initAccount({
    authClientId: 'external-drive',
    apiClient,
    credentials,
    cryptoProxy: CryptoProxy,
    srpApi: { computeKeyPassword, generateKeySalt, getRandomSrpVerifier, getSrp },
    logger,
    accountUrl: baseUrl.startsWith('drive-api.') ? baseUrl.replace(/^drive-api\./, 'account.') : undefined,
  });

  const httpClient = {
    fetchJson: (o: { url: string; method: string; json?: unknown; body?: BodyInit; headers?: Headers; timeoutMs?: number; signal?: AbortSignal }) =>
      apiClient.authenticatedRequest(o.url, {
        method: o.method,
        ...(o.json !== undefined ? { json: o.json } : o.body !== undefined ? { body: o.body } : {}),
        headers: o.headers,
        timeout: o.timeoutMs,
        signal: o.signal,
        throwHttpErrors: false,
      }),
    fetchBlob: (o: { url: string; method: string; body?: BodyInit; headers?: Headers; timeoutMs?: number; signal?: AbortSignal }) =>
      apiClient.authenticatedRequest(o.url, {
        method: o.method,
        body: o.body,
        headers: o.headers,
        timeout: o.timeoutMs,
        signal: o.signal,
        throwHttpErrors: false,
      }),
  };

  let latestEvent: string | null = null;
  const entitiesCache = new MemoryCache<string>();
  const cryptoCache = new MemoryCache<unknown>();
  const sdk = new ProtonDriveClient({
    httpClient: httpClient as never,
    entitiesCache: entitiesCache as never,
    cryptoCache: cryptoCache as never,
    account: {
      getOwnPrimaryAddress: () => addresses.getOwnPrimaryAddress(),
      getOwnAddresses: () => addresses.getOwnAddresses(),
      getOwnAddress: (x: string) => addresses.getOwnAddress(x),
      hasProtonAccount: (e: string) => addresses.hasProtonAccount(e),
      getPublicKeys: (e: string, f?: boolean) => addresses.getPublicKeys(e, f),
    } as never,
    openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy as never),
    srpModule: { getSrp, computeKeyPassword, generateKeySalt, getRandomSrpVerifier } as never,
    config: { baseUrl, clientUid: opts.clientUid },
    featureFlagProvider: new NullFeatureFlagProvider(),
    latestEventIdProvider: { getLatestEventId: async () => latestEvent },
  } as never);

  /* ---------------- events (cache coherence) ---------------- */
  const folderChangedCbs = new Set<(uid: string) => void>();
  let subscription: EventSubscription | null = null;
  const startEvents = async () => {
    if (subscription || !credentials.isLoggedIn()) return;
    const root = await sdk.getMyFilesRootFolder();
    subscription = await sdk.subscribeToTreeEvents(root.treeEventScopeId, async (ev) => {
      latestEvent = ev.eventId ?? latestEvent;
      const e = ev as unknown as { parentNodeUid?: string; nodeUid?: string };
      if (e.parentNodeUid) folderChangedCbs.forEach((cb) => cb(e.parentNodeUid!));
      if (e.nodeUid) folderChangedCbs.forEach((cb) => cb(e.nodeUid!));
    });
  };
  const stopEvents = () => {
    try {
      subscription?.dispose();
    } catch {
      /* ignore */
    }
    subscription = null;
  };

  /* ---------------- login (browser fork flow) ---------------- */
  let loginState: LoginStatus = { state: credentials.isLoggedIn() ? 'authenticated' : 'idle' };
  let loginAbort: AbortController | null = null;
  const startLogin = async (): Promise<LoginStatus> => {
    if (loginState.state === 'awaiting' && loginAbort && !loginAbort.signal.aborted) return loginState;
    loginAbort?.abort();
    const ctrl = new AbortController();
    loginAbort = ctrl;
    loginState = { state: 'awaiting' };
    let resolveUrl!: () => void;
    const urlReady = new Promise<void>((r) => (resolveUrl = r));
    void (async () => {
      try {
        stopEvents();
        await Promise.allSettled([entitiesCache.clear(), cryptoCache.clear()]);
        await auth.authViaWeb((url) => {
          if (ctrl.signal.aborted) throw new Error('Cancelled');
          loginState = { state: 'awaiting', signInUrl: url };
          resolveUrl();
        }, ctrl.signal);
        if (loginAbort === ctrl) loginState = { state: 'authenticated' };
        startEvents().catch((e) => log('warn', `event subscription failed: ${e instanceof Error ? e.message : e}`));
      } catch (e) {
        if (loginAbort === ctrl) {
          loginState = ctrl.signal.aborted
            ? { state: 'idle' }
            : { state: 'failed', error: /timed out/i.test(String((e as Error)?.message)) ? 'Sign-in timed out — start again.' : 'Proton sign-in failed — try again.' };
        }
        log('warn', `login failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        resolveUrl();
      }
    })();
    await Promise.race([urlReady, new Promise((r) => setTimeout(r, 30_000))]);
    return loginState;
  };

  /* ---------------- account ---------------- */
  let accountCache: { at: number; value: AccountInfo } | null = null;
  const account = async (force = false): Promise<AccountInfo | null> => {
    if (!credentials.isLoggedIn()) return null;
    if (!force && accountCache && Date.now() - accountCache.at < 60_000) return accountCache.value;
    const res = await apiClient.authenticatedRequest.get(`${apiClient.baseUrlWithProtocol}/core/v4/users`, { throwHttpErrors: false });
    if (res.status === 401 || res.status === 403 || !credentials.isLoggedIn()) {
      // The refresh hook already tried; a 4xx refresh rejection signed us out.
      if (!credentials.isLoggedIn()) return null;
      throw mapError({ statusCode: res.status, message: `HTTP ${res.status}` });
    }
    if (!res.ok) throw mapError({ statusCode: res.status, name: res.status >= 500 ? 'ServerError' : '', message: `HTTP ${res.status}` });
    const u = ((await res.json()) as { User?: Record<string, any> }).User ?? {};
    if (typeof u.ID !== 'string') throw new DriveError('SERVER', 'Proton returned no user id');
    const value: AccountInfo = {
      userId: u.ID,
      email: u.Email ?? null,
      displayName: u.DisplayName ?? u.Name ?? null,
      maxSpace: Number(u.MaxSpace ?? 0),
      usedSpace: Number(u.UsedSpace ?? 0),
      driveUsed: Number(u.ProductUsedSpace?.Drive ?? 0),
    };
    accountCache = { at: Date.now(), value };
    return value;
  };

  /* ---------------- drive service ---------------- */
  const thumbGate = semaphore(Math.max(1, opts.thumbnailConcurrency ?? 1));
  const guard = async <T>(fn: () => Promise<T>, fallback?: DriveErrorCode): Promise<T> => {
    if (!credentials.isLoggedIn()) throw new DriveError('UNAUTHENTICATED', 'Proton login required');
    try {
      return await fn();
    } catch (e) {
      const mapped = mapError(e, fallback);
      if (!credentials.isLoggedIn()) throw new DriveError('UNAUTHENTICATED', 'Proton session expired', { cause: e });
      throw mapped;
    }
  };

  const metadataFor = async (file: LocalFile, o: UploadOptions) => {
    let additionalMetadata: object | undefined;
    if (o.mediaType.startsWith('image/') && o.mediaType !== 'image/svg+xml') {
      try {
        additionalMetadata = (await generateAdditionalNodeMetadata(await headerBlob(file.abs, file.size, file.mtimeMs), o.mediaType)).additionalMetadata;
      } catch {
        additionalMetadata = undefined; // metadata is optional; never fail an upload over EXIF
      }
    }
    return {
      mediaType: o.mediaType,
      expectedSize: file.size,
      modificationTime: file.mtimeMs > 0 ? new Date(Math.round(file.mtimeMs)) : undefined,
      ...(additionalMetadata && { additionalMetadata }),
      ...(o.overrideDraft && { overrideExistingDraftByOtherClient: true }),
    };
  };

  const thumbnailsFor = async (file: LocalFile, o: UploadOptions): Promise<Thumbnail[]> => {
    if (!o.thumbnails) return [];
    try {
      return await thumbGate(() => makeThumbnails(file.abs, o.mediaType));
    } catch (e) {
      log('debug', `thumbnail skipped for ${file.abs}: ${e instanceof Error ? e.message : e}`);
      return []; // a broken image still gets backed up, just without a preview
    }
  };

  const runUpload = async (
    getUploader: (meta: Awaited<ReturnType<typeof metadataFor>>) => Promise<{ uploadFromStream: (s: ReadableStream, t: Thumbnail[], p?: (n: number) => void) => Promise<{ completion(): Promise<{ nodeUid: string; nodeRevisionUid: string }> }> }>,
    file: LocalFile,
    o: UploadOptions,
  ): Promise<UploadResult> => {
    const meta = await metadataFor(file, o);
    const thumbs = await thumbnailsFor(file, o);
    const uploader = await getUploader(meta);
    const hash = createHash('sha1');
    const stream = fileStream(file.abs, o, hash);
    try {
      const ctrl = await uploader.uploadFromStream(stream, thumbs);
      const done = await ctrl.completion();
      return { nodeUid: done.nodeUid, revisionUid: done.nodeRevisionUid, sha1: hash.digest('hex') };
    } finally {
      await stream.cancel().catch(() => {}); // closes the fd if the SDK stopped early
    }
  };

  const drive: DriveService = {
    root: () => guard(async () => toRemote(await sdk.getMyFilesRootFolder())),
    async getNode(uid) {
      return guard(async () => {
        for await (const n of sdk.iterateNodes([uid])) {
          if ('missingUid' in n) return null;
          return toRemote(n as NodeEntity);
        }
        return null;
      });
    },
    async *children(folderUid, signal) {
      if (!credentials.isLoggedIn()) throw new DriveError('UNAUTHENTICATED', 'Proton login required');
      // Child uids page by page, node metadata in batches (served from the entity
      // cache when fresh) — memory stays bounded by one batch for huge folders.
      const BATCH = 100;
      let batch: string[] = [];
      const flush = async function* () {
        const uids = batch;
        batch = [];
        for await (const n of sdk.iterateNodes(uids, signal)) {
          if ('missingUid' in n) continue; // removed between listing and loading
          const r = toRemote(n as NodeEntity);
          if (!r.trashed) yield r;
        }
      };
      try {
        for await (const uid of sdk.iterateFolderChildrenNodeUids(folderUid, undefined, signal)) {
          batch.push(uid);
          if (batch.length >= BATCH) yield* flush();
        }
        if (batch.length) yield* flush();
      } catch (e) {
        throw mapError(e);
      }
    },
    createFolder: (parentUid, name) =>
      guard(async () => {
        try {
          return toRemote(await sdk.createFolder(parentUid, name));
        } catch (e) {
          const m = mapError(e);
          if (m.code !== 'NAME_CONFLICT' || !m.existingUid || m.existingIsDraft) throw m;
          await entitiesCache.removeEntities([`node-${m.existingUid}`]).catch(() => {});
          const ex = toRemote(await sdk.getNode(m.existingUid));
          if (ex.kind !== 'folder' || ex.parentUid !== parentUid || ex.trashed || ex.name !== name) throw m;
          return ex;
        }
      }),
    uploadNew: (parentUid, name, file, o) =>
      guard(() => runUpload((meta) => sdk.getFileUploader(parentUid, name, meta, o.signal) as never, file, o)),
    uploadRevision: (nodeUid, file, o) =>
      guard(() => runUpload((meta) => sdk.getFileRevisionUploader(nodeUid, meta, o.signal) as never, file, o)),
    trash: (uids) =>
      guard(async () => {
        const out: { uid: string; ok: boolean; error?: string; code?: DriveErrorCode }[] = [];
        for await (const r of sdk.trashNodes(uids)) {
          if (r.ok) out.push({ uid: r.uid, ok: true });
          else {
            const m = mapError(r.error);
            out.push({ uid: r.uid, ok: false, error: m.message, code: m.code });
          }
        }
        return out;
      }),
    rename: (uid, newName) => guard(async () => toRemote(await sdk.renameNode(uid, newName))),
    revisions: (uid) =>
      guard(async () => {
        const out: { uid: string; active: boolean; size: number | null; sha1: string | null; created: number }[] = [];
        for await (const r of sdk.iterateRevisions(uid)) {
          out.push({
            uid: r.uid,
            active: r.state === 'active',
            size: r.claimedSize ?? null,
            sha1: r.claimedDigests?.sha1 ?? null,
            created: r.creationTime.getTime(),
          });
        }
        return out.sort((a, b) => b.created - a.created);
      }),
    download: (revisionUid, destPath) =>
      guard(async () => {
        const downloader = await sdk.getFileRevisionDownloader(revisionUid);
        const fh = await fs.promises.open(destPath, 'w', 0o600);
        let written = 0;
        try {
          const sink = new WritableStream<Uint8Array>({
            async write(chunk) {
              await fh.write(chunk);
              written += chunk.byteLength;
            },
          });
          await downloader.downloadToStream(sink).completion();
        } finally {
          await fh.close();
        }
        return written;
      }),
  };

  return {
    versions: {
      app: opts.appVersion,
      appVersionHeader: header,
      sdk: SDK_VERSION,
      sdkTag: UPSTREAM.tag,
      sdkCommit: UPSTREAM.commit,
      crypto: UPSTREAM.crypto,
    },
    drive,
    hasSession: () => credentials.isLoggedIn(),
    account,
    login: {
      start: startLogin,
      status: () => (loginState.state === 'awaiting' ? loginState : credentials.isLoggedIn() ? { state: 'authenticated' } : loginState.state === 'authenticated' ? { state: 'idle' } : loginState),
      cancel: () => {
        loginAbort?.abort();
        loginAbort = null;
        if (loginState.state === 'awaiting') loginState = { state: 'idle' };
      },
    },
    async logout() {
      loginAbort?.abort();
      stopEvents();
      accountCache = null;
      // Revoke the session server-side (best-effort), then forget it locally.
      try {
        if (credentials.isLoggedIn()) await apiClient.authenticatedRequest.delete(`${apiClient.baseUrlWithProtocol}/auth/v4`, { throwHttpErrors: false, timeout: 10_000 });
      } catch {
        /* offline logout still removes the local session */
      }
      await auth.logout();
      await Promise.allSettled([entitiesCache.clear(), cryptoCache.clear()]);
      loginState = { state: 'idle' };
    },
    async clearCaches() {
      await Promise.allSettled([entitiesCache.clear()]);
    },
    startEvents,
    onFolderChanged: (cb) => void folderChangedCbs.add(cb),
    onSessionLost: (cb) => void lostCbs.add(cb),
    notices: () => [...notices],
    async dispose() {
      loginAbort?.abort();
      stopEvents();
    },
  };
}

function cmpSemver(a: string, b: string): number {
  const pa = a.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const pb = b.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}
