// The job engine and HTTP routes share these operations in both images.
import * as cli from './cli';
import { SdkError, sdkEnabled, sdkWorker } from './sdk-worker';

export { normalizeProtonPath, cleanCliError, looksUnauthenticated, describeUploadError, uploadsBusy, setBackupRunning } from './cli';
export type { FileStrategy, FolderStrategy, RunResult } from './cli';

type DriveResult<T> = { ok: true; data: T } | { ok: false; error: string; raw?: string; code?: string };

async function result<T>(operation: Promise<T>): Promise<DriveResult<T>> {
  try {
    return { ok: true, data: await operation };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Drive operation failed',
      code: error instanceof SdkError ? error.code : undefined,
    };
  }
}

export async function listDrive(path: string) {
  return sdkEnabled()
    ? result(sdkWorker.call('list', { path: cli.normalizeProtonPath(path) }))
    : cli.listDrive(path);
}

export function listDriveCached(path: string) {
  return sdkEnabled() ? listDrive(path) : cli.listDriveCached(path);
}

export function createFolder(parentPath: string, name: string, existingOk = false) {
  return sdkEnabled()
    ? result(sdkWorker.call('mkdir', { parentPath: cli.normalizeProtonPath(parentPath), name, existingOk }))
    : cli.createFolder(parentPath, name);
}

export function trashDrive(path: string) {
  return sdkEnabled()
    ? result(sdkWorker.call('trash', { path: cli.normalizeProtonPath(path) }))
    : cli.trashDrive(path);
}

export function renameDrive(path: string, name: string) {
  return sdkEnabled()
    ? result(sdkWorker.call('rename', { path: cli.normalizeProtonPath(path), name }))
    : cli.renameDrive(path, name);
}

export function drivePathExists(path: string) {
  return sdkEnabled()
    ? sdkWorker.call('exists', { path: cli.normalizeProtonPath(path) }).catch(() => null)
    : cli.drivePathExists(path);
}

export async function clearTreeCache() {
  if (sdkEnabled()) await sdkWorker.call('refresh', {});
  else cli.clearTreeCache();
}

export async function upload(
  sources: string[],
  dest: string,
  fileStrategy: cli.FileStrategy,
  folderStrategy: cli.FolderStrategy,
  progress?: (bytes: number) => void,
  skipThumbnails = false,
  includeHidden = false,
): Promise<cli.RunResult> {
  if (!sdkEnabled()) return cli.upload(sources, dest, fileStrategy, folderStrategy, progress, skipThumbnails);
  const transfer = await result(sdkWorker.call('upload', {
    sources, dest: cli.normalizeProtonPath(dest), fileStrategy, folderStrategy, skipThumbnails, includeHidden,
  }, progress));
  return transfer.ok ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: transfer.error };
}

export function killActiveUpload() {
  if (sdkEnabled()) void sdkWorker.call('cancel', {}).catch(() => {});
  else cli.killActiveUpload();
}

export function startLogin() {
  if (sdkEnabled()) return sdkWorker.call('login', {});
  cli.clearAuthCache();
  return cli.loginManager.start();
}

export async function authStatus(force = false) {
  if (sdkEnabled()) {
    const { authenticated, loginState, error } = await sdkWorker.call('status', { force });
    return { authenticated, loginState, error };
  }
  const authenticated = await cli.isAuthenticated(force);
  const login = cli.loginManager.status();
  return { authenticated, loginState: login.state, signInUrl: login.signInUrl, error: login.error };
}

export async function isAuthenticated(force = false) {
  return sdkEnabled() ? (await authStatus(force)).authenticated : cli.isAuthenticated(force);
}

export async function logout() {
  if (sdkEnabled()) return sdkWorker.call('logout', {});
  await cli.runCli(['auth', 'logout'], 30_000).catch(() => {});
  cli.loginManager.reset();
  cli.clearAuthCache();
}

export async function driveVersion() {
  return sdkEnabled() ? (await sdkWorker.call('version', {})).sdkVersion : cli.getCliVersion();
}
