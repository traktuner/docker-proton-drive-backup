// Bundled inside the pinned Proton SDK tree (cli/src/backup-worker).
import { createInterface } from 'node:readline';
import { CryptoProxy } from '@protontech/crypto';
import { NodeType, NodeWithSameNameExistsValidationError, type NodeEntity } from '@protontech/drive-sdk';
import { init } from '../init';
import { upload } from './upload';
import { AccountMismatch, bindAccount } from './account-binding';
import { DriveError, resolve, segments, validName } from './drive-path';

declare const SDK_VERSION: string;
const sdkVersion = SDK_VERSION;
const appVersion = 'external-drive-nas_backup@0.1.0-alpha';
type Context = Awaited<ReturnType<typeof init>>;
type Params = Record<string, unknown>;
type LoginState = {
  state: 'idle' | 'awaiting' | 'authenticated' | 'failed';
  signInUrl?: string;
  error?: string;
};

process.umask(0o077);
process.env.PROTON_DRIVE_CACHE_DIR ??= '/data/proton-sdk';
process.env.PROTON_DRIVE_LOG_LEVEL = 'ERROR';
process.env.PROTON_DRIVE_UNSAFE_CACHE = 'false';
process.env.PROTON_DRIVE_BASE_URL = 'drive-api.proton.me';
process.env.PROTON_DRIVE_CREDENTIALS_STORE ??= 'pass';
let context: Promise<Context> | undefined;
function getContext() {
  if (process.env.PROTON_DRIVE_CREDENTIALS_STORE === 'unsafe_file')
    throw new Error('An encrypted session store is required');
  return (context ??= init({
    appVersion,
    sdkVersion,
    clientUidPrefix: 'nas_backup',
    enableMetrics: false,
    enableConsoleLog: false,
    enablePersistedEvents: true,
  })
    .then((ctx) => {
      if (!ctx.eventsProvider.canListenForEvents())
        throw new Error('Another process owns the SDK data directory');
      usedSession = ctx.auth.isLoggedIn();
      return ctx;
    })
    .catch((error) => {
      // init may already have installed the singleton crypto endpoint and
      // acquired its event lock. Restart cleanly if startup failed midway.
      closing = true;
      exitAfterReply = true;
      context = undefined;
      throw error;
    }));
}

let loginState: LoginState = { state: 'idle' };
let login: { controller: AbortController; ready: Promise<void>; finished: Promise<void> } | undefined;
const uploads = new Set<AbortController>();
let activeOperations = 0;
let exclusive = false;
let closing = false;
let inputClosed = false;
let cancelGeneration = 0;
let exitAfterReply = false;
let usedSession = false;
let startingLogin: Promise<LoginState> | undefined;
const pending = new Set<Promise<void>>();

const verified = new WeakMap<Context, Promise<void>>();
function ensureAccount(ctx: Context) {
  let check = verified.get(ctx);
  if (!check) {
    check = (async () => {
      const response = await ctx.apiClient.authenticatedRequest
        .get(ctx.apiClient.baseUrlWithProtocol + '/core/v4/users')
        .json<{ User?: { ID?: string } }>();
      await bindAccount(ctx.config.appDir, response.User?.ID);
    })().catch((error) => {
      // A network error must block all transfers, but a later request
      // can retry the identity check. Never replace the recorded account.
      verified.delete(ctx);
      throw error;
    });
    verified.set(ctx, check);
  }
  return check;
}

function status(ctx: Context): LoginState {
  if (login) return loginState;
  if (ctx.auth.isLoggedIn()) return { state: 'authenticated' };
  return loginState.state === 'authenticated' ? { state: 'idle' } : loginState;
}

async function startLogin(ctx: Context): Promise<LoginState> {
  if (login) {
    await login.ready;
    return status(ctx);
  }
  if (ctx.auth.isLoggedIn()) {
    try {
      await ensureAccount(ctx);
      return status(ctx);
    } catch (err) {
      if (!(err instanceof AccountMismatch)) throw err;
      await ctx.auth.logout();
    }
  }
  if (usedSession) {
    // A rejected refresh removed credentials. Discard the old account's
    // in-memory keys, entity caches and event subscriptions before pairing.
    exclusive = true;
    try {
      await ctx.eventsManager.clear();
      await clearCaches(ctx);
      await ctx.dispose();
      await CryptoProxy.releaseEndpoint();
      context = undefined;
      ctx = await getContext();
    } finally {
      exclusive = false;
    }
  }
  let ready!: () => void;
  const attempt = {
    controller: new AbortController(),
    ready: new Promise<void>((r) => {
      ready = r;
    }),
    finished: Promise.resolve(),
  };
  login = attempt;
  loginState = { state: 'awaiting' };
  attempt.finished = (async () => {
    try {
      // A previous session may have expired before the last process stopped.
      await ctx.eventsProvider.clear();
      await clearCaches(ctx);
      await ctx.auth.authViaWeb((signInUrl) => {
        if (attempt.controller.signal.aborted) throw new Error('Cancelled');
        loginState = { state: 'awaiting', signInUrl };
        ready();
      }, attempt.controller.signal);
      usedSession = true;
      await ensureAccount(ctx);
      await ctx.eventsManager.startSubscriptions();
      loginState = { state: 'authenticated' };
    } catch (err) {
      loginState = {
        state: 'failed',
        error:
          err instanceof AccountMismatch
            ? err.message
            : 'Proton sign-in failed. Check the session store and retry.',
      };
      // A failed post-login check must never leave a runnable new session.
      if (ctx.auth.isLoggedIn()) await ctx.auth.logout();
    } finally {
      login = undefined;
      ready();
    }
  })();
  await attempt.ready;
  return status(ctx);
}

async function clearCaches(ctx: Context) {
  await Promise.all([ctx.caches.entitiesCache.clear(), ctx.caches.cryptoCache.clear()]);
}

function string(p: Params, key: string) {
  const value = p[key];
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`Invalid ${key}`);
  return value;
}

function entry(node: NodeEntity) {
  if (!node.name.ok || node.name.value.includes('/'))
    throw new Error('Folder contains an unreadable or unrepresentable Drive name');
  const revision = node.activeRevision;
  return {
    uid: node.uid,
    name: node.name.value,
    type: node.type,
    mediaType: node.mediaType,
    size: revision?.claimedSize ?? node.totalStorageSize,
    mtimeMs: revision?.claimedModificationTime?.getTime(),
    sha1: revision?.claimedDigests?.sha1,
  };
}

async function drive(ctx: Context, method: string, p: Params, id: number) {
  switch (method) {
    case 'exists':
      try {
        await resolve(ctx, string(p, 'path'), true);
        return true;
      } catch (err) {
        return err instanceof DriveError && err.code === 'NOT_FOUND' ? false : null;
      }
    case 'list': {
      const folder = await resolve(ctx, string(p, 'path'), true);
      const entries = [];
      for await (const node of ctx.sdk.iterateFolderChildren(folder)) entries.push(entry(node));
      return entries;
    }
    case 'mkdir': {
      const parent = await resolve(ctx, string(p, 'parentPath'), true);
      const name = validName(string(p, 'name'));
      try {
        return entry(await ctx.sdk.createFolder(parent, name));
      } catch (error) {
        if (
          !p.existingOk ||
          !(error instanceof NodeWithSameNameExistsValidationError) ||
          error.isUnfinishedUpload ||
          !error.existingNodeUid
        )
          throw error;
        await ctx.caches.entitiesCache.removeEntities(['node-' + error.existingNodeUid]);
        const existing = await ctx.sdk.getNode(error.existingNodeUid);
        if (
          existing.type !== NodeType.Folder ||
          existing.parentUid !== parent.uid ||
          existing.trashTime ||
          !existing.name.ok ||
          existing.name.value !== name
        )
          throw new Error('Cannot confirm an existing destination folder');
        return entry(existing);
      }
    }
    case 'rename':
    case 'trash': {
      const path = string(p, 'path');
      if (!segments(path).length) throw new Error('Cannot modify My files root');
      const node = await resolve(ctx, path, true);
      if (method === 'rename') return entry(await ctx.sdk.renameNode(node, validName(string(p, 'name'))));
      for await (const result of ctx.sdk.trashNodes([node])) {
        if (!result.ok) throw result.error;
        if (result.uid === node.uid) return true;
      }
      throw new Error('Drive did not confirm the trash operation');
    }
    case 'quota': {
      const { User } = await ctx.apiClient.authenticatedRequest
        .get(`${ctx.apiClient.baseUrlWithProtocol}/core/v4/users`)
        .json<{ User: Record<string, unknown> }>();
      const { MaxSpace, UsedSpace, ProductUsedSpace, Email, DisplayName, Name } = User;
      return { User: { MaxSpace, UsedSpace, ProductUsedSpace, Email, DisplayName, Name } };
    }
    case 'upload': {
      const sources = p.sources;
      if (
        !Array.isArray(sources) ||
        sources.length === 0 ||
        !sources.every((s) => typeof s === 'string' && s.length)
      )
        throw new Error('Invalid upload source list');
      const dest = string(p, 'dest');
      const controller = new AbortController();
      uploads.add(controller);
      try {
        const target = await resolve(ctx, dest, true);
        controller.signal.throwIfAborted();
        return await upload(
          ctx,
          {
            sources,
            fileStrategy: string(p, 'fileStrategy'),
            folderStrategy: string(p, 'folderStrategy'),
            skipThumbnails: p.skipThumbnails === true,
            includeHidden: p.includeHidden === true,
          },
          controller.signal,
          (progress) => {
            process.stdout.write(JSON.stringify({ id, progress }) + '\n');
          },
          target,
        );
      } finally {
        uploads.delete(controller);
      }
    }
    default:
      throw new Error('Unknown SDK method');
  }
}

async function dispatch(method: string, p: Params, id: number) {
  if (method === 'version') return { sdkVersion, appVersion };
  if (method === 'cancel') {
    cancelGeneration++;
    for (const active of uploads) active.abort();
    return true;
  }
  const generation = cancelGeneration;
  const ctx = await getContext();
  if (closing || exclusive) throw new Error('SDK worker is busy');
  if (inputClosed && (method === 'upload' || method === 'login')) throw new Error('SDK client disconnected');
  if (method === 'status') {
    if (ctx.auth.isLoggedIn() && !login) {
      activeOperations++;
      try {
        // A forced check exercises the 401/refresh hook via the account API.
        if (p.force === true) verified.delete(ctx);
        await ensureAccount(ctx);
      } catch (err) {
        if (err instanceof AccountMismatch)
          return { authenticated: false, loginState: 'failed', error: err.message };
        if (ctx.auth.isLoggedIn()) throw err; // A transient failure is not a logout.
      } finally {
        activeOperations--;
      }
    }
    const { state, ...details } = status(ctx);
    return { authenticated: state === 'authenticated', loginState: state, ...details };
  }
  if (method === 'login') {
    if (activeOperations) throw new Error('A Drive operation is running');
    return (startingLogin ??= startLogin(ctx).finally(() => {
      startingLogin = undefined;
    }));
  }
  if (method === 'logout' || method === 'refresh') {
    if (activeOperations || (startingLogin && !login) || (method === 'refresh' && login))
      throw new Error('A Drive operation is running');
    exclusive = true;
    try {
      if (method === 'logout') {
        login?.controller.abort();
        await login?.finished;
        // Exit even on cleanup failure to discard loaded keys. Report failure
        // to the caller if the persisted session could not be removed.
        exitAfterReply = true;
        closing = true;
        await ctx.auth.logout();
        await ctx.eventsManager.clear();
      }
      await clearCaches(ctx);
      return true;
    } finally {
      exclusive = false;
    }
  }
  if (login || !ctx.auth.isLoggedIn()) throw new DriveError('UNAUTHENTICATED', 'Proton login required');
  usedSession = true;
  // The app limits parallel transfer batches. All share this SDK's request
  // limiter, session refresh hook, and crypto context.
  activeOperations++;
  try {
    await ensureAccount(ctx);
    if (method === 'upload' && (inputClosed || generation !== cancelGeneration))
      throw new Error('Upload cancelled');
    return await drive(ctx, method, p, id);
  } finally {
    activeOperations--;
  }
}

function send(value: unknown) {
  return new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(value) + '\n', (err) => (err ? reject(err) : resolve())),
  );
}

async function handle(line: string) {
  let id: number | null = null;
  let method = '';
  try {
    const request = JSON.parse(line);
    if (!Number.isSafeInteger(request?.id) || typeof request.method !== 'string')
      throw new Error('Invalid SDK request');
    id = request.id as number;
    method = request.method;
    const result = await dispatch(method, request.params ?? {}, id);
    await send({ id, result });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'SDK operation failed';
    await send({
      id,
      error: error.replace(/https?:\/\/[^\s]+/gi, '[URL]').slice(0, 480),
      code: err instanceof DriveError ? err.code : undefined,
    });
  } finally {
    if (exitAfterReply) await stop();
  }
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  closing = true;
  for (const active of uploads) active.abort();
  login?.controller.abort();
  try {
    await login?.finished;
    await (await context)?.dispose();
  } finally {
    process.exit(0);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (closing || !line.trim()) return;
  const task = handle(line);
  pending.add(task);
  void task.finally(() => pending.delete(task));
});
lines.on('close', async () => {
  // Terminate transfers if the parent died. A finite pipe used for probing
  // version/status can still finish and flush its replies.
  inputClosed = true;
  for (const active of uploads) active.abort();
  login?.controller.abort();
  await Promise.allSettled(pending);
  await stop();
});
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
