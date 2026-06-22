import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import nodePath from 'node:path';

/**
 * Thin, robust wrapper around the official `proton-drive` CLI.
 *
 * Design notes (see memory/proton-drive-cli-internals):
 *  - Every operation except login runs as a ONE-SHOT process: spawn, read JSON,
 *    exit. No fragile REPL/prompt parsing.
 *  - Secrets use the file-based store (PROTON_DRIVE_UNSAFE_SECRETS=1) so the CLI
 *    never touches libsecret/gnome-keyring/D-Bus. This is the only thing that
 *    works headless in Docker.
 *  - PROTON_DRIVE_CACHE_DIR points session + cache + logs at one persistent dir.
 *  - Login is a long-lived polling process: it prints {"signInUrl":...} then
 *    polls Proton until the browser sign-in completes, then exits 0.
 */

export const CLI_PATH = process.env.PROTON_DRIVE_CLI || '/usr/local/bin/proton-drive';
export const CACHE_DIR = process.env.PROTON_DRIVE_CACHE_DIR || '/data/proton';
export const PROTON_ROOT = '/my-files';

function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PROTON_DRIVE_UNSAFE_SECRETS: '1',
    PROTON_DRIVE_CACHE_DIR: CACHE_DIR,
    PROTON_DRIVE_LOG_LEVEL: process.env.PROTON_DRIVE_LOG_LEVEL || 'ERROR',
    HOME: process.env.HOME || '/home/app',
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The proton-drive CLI tolerates concurrent invocations (the SQLite tree cache
 * in CACHE_DIR uses WAL - verified: list/create-folder/trash all run fine while
 * a large upload is in progress). So we do NOT serialize reads/quick ops; the UI
 * stays responsive during uploads.
 *
 * Two safeguards remain:
 *  - a rare "database is locked" is retried with backoff (retryOnLock).
 *  - uploads are mutually exclusive via uploadLock so two backup sets never
 *    upload at once (heavier, and the user wants them sequential).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isLockError = (s: string) => /database is locked|SQLITE_BUSY|is locked/i.test(s);

interface RunOpts {
  /** Retry transient "database is locked" errors. Default true; off for uploads. */
  retryOnLock?: boolean;
  /** Called with the spawned process (used to make uploads cancellable). */
  onSpawn?: (proc: ChildProcessWithoutNullStreams) => void;
  /** Called for each complete stderr line (used to parse live upload metrics). */
  onStderrLine?: (line: string) => void;
}

/** Run the CLI once and resolve when the process exits (with lock-retry). */
export async function runCli(
  args: string[],
  timeoutMs = 120_000,
  opts: RunOpts = {},
): Promise<RunResult> {
  const maxAttempts = opts.retryOnLock === false ? 1 : 6;
  for (let attempt = 1; ; attempt++) {
    const res = await spawnCli(args, timeoutMs, opts);
    if (attempt < maxAttempts && res.code !== 0 && isLockError(res.stdout + res.stderr)) {
      await sleep(120 * attempt + Math.random() * 100);
      continue;
    }
    return res;
  }
}

// Active upload processes (possibly several concurrent), so a cancel kills them
// all. On globalThis so the cancel API route (a separate Next.js module instance)
// kills the SAME processes the running job registered — see control.ts.
const _g = globalThis as unknown as {
  __pdActiveUploads?: Set<ChildProcessWithoutNullStreams>;
  __pdBackupRunning?: { v: boolean };
};
const activeUploads = _g.__pdActiveUploads ?? (_g.__pdActiveUploads = new Set<ChildProcessWithoutNullStreams>());
export function killActiveUpload() {
  for (const p of activeUploads) p.kill('SIGKILL');
}

// A backup run does more than spawn upload processes — it also creates folders and
// diffs/hashes between batches, leaving windows with no active upload. Clearing the
// CLI tree cache (resync) in one of those windows can evict a just-created folder
// node and break the run ("Node not found"). So mark the whole run busy, not just
// the upload spawns. On globalThis to survive across route module instances.
const backupRunning = _g.__pdBackupRunning ?? (_g.__pdBackupRunning = { v: false });
export function setBackupRunning(v: boolean) {
  backupRunning.v = v;
}

/** True while a backup is uploading OR otherwise mid-run — used to defer resync. */
export const uploadsBusy = () => activeUploads.size > 0 || backupRunning.v;

/**
 * Clear the CLI's tree cache so the next `list` re-fetches fresh from the server.
 * Needed because `list` serves a cached tree that can be stale after external
 * changes (e.g. a folder deleted via Proton Drive web). The session is untouched;
 * the CLI rebuilds the cache on demand.
 */
export function clearTreeCache() {
  invalidateListCache();
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (/^cache-.*\.sqlite/.test(f) || f === 'events.json') {
        fs.rmSync(nodePath.join(CACHE_DIR, f), { force: true });
      }
    }
  } catch {
    /* best-effort */
  }
}


function spawnCli(
  args: string[],
  timeoutMs: number,
  opts: RunOpts = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLI_PATH, args, { env: cliEnv() });
    opts.onSpawn?.(proc);
    let stdout = '';
    let stderr = '';

    // timeoutMs <= 0 means no timeout (uploads of huge files can run for hours).
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`proton-drive ${args.join(' ')} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

    // Line-buffer both streams (the CLI logs metrics to one of them) and emit
    // complete lines to onStderrLine. Separate buffers so partial lines don't mix.
    let outBuf = '';
    let errBuf = '';
    const pump = (chunk: string, isOut: boolean) => {
      if (!opts.onStderrLine) return;
      let buf = (isOut ? outBuf : errBuf) + chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        opts.onStderrLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (isOut) outBuf = buf;
      else errBuf = buf;
    };
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      pump(s, true);
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      pump(s, false);
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Extract a JSON value (object or array) from CLI output. */
export function parseJson<T = unknown>(raw: string): T | null {
  // The CLI colorizes JSON when attached to a TTY; strip ANSI escapes so the
  // output parses regardless of how it was launched.
  const output = raw.replace(ANSI_RE, '').trim();
  if (!output) return null;

  // 1. The common case: the whole output is one JSON value (the CLI
  //    pretty-prints arrays across many lines, so a line-by-line scan would
  //    wrongly match a single element).
  try {
    return JSON.parse(output) as T;
  } catch {
    /* fall through */
  }

  // 2. JSON embedded in log noise: take the first bracket to its last match.
  const candidates = [output.indexOf('{'), output.indexOf('[')].filter((i) => i >= 0);
  if (candidates.length) {
    const start = Math.min(...candidates);
    const close = output[start] === '[' ? ']' : '}';
    const end = output.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(output.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
  }

  // 3. A single JSON value sitting on its own line amid other output.
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (t[0] === '{' || t[0] === '[') {
      try {
        return JSON.parse(t) as T;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

export type CliResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; raw?: string };

/** Run a CLI command in JSON mode and parse the result. */
export async function runJson<T = unknown>(
  args: string[],
  timeoutMs?: number,
  opts?: RunOpts,
): Promise<CliResult<T>> {
  let res: RunResult;
  try {
    // The CLI only accepts global flags AFTER the command words, e.g.
    // `filesystem list <path> -j` (not `-j filesystem list`).
    res = await runCli([...args, '-j'], timeoutMs, opts);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const parsed = parseJson<T>(res.stdout);
  if (parsed !== null && res.code === 0) {
    return { ok: true, data: parsed };
  }
  // Surface a useful error message.
  const errText =
    parseJsonError(res.stdout) ||
    res.stderr.trim() ||
    res.stdout.trim() ||
    `CLI exited with code ${res.code}`;
  return { ok: false, error: errText, raw: res.stdout + res.stderr };
}

function parseJsonError(output: string): string | null {
  const obj = parseJson<{ error?: string; message?: string }>(output);
  if (obj && typeof obj === 'object') {
    return obj.error || obj.message || null;
  }
  return null;
}

const AUTH_ERROR_PATTERNS = [
  'no session',
  'please login',
  'not authenticated',
  'not signed',
  'err_secrets',
];

export function looksUnauthenticated(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((p) => lower.includes(p));
}

/* ------------------------------------------------------------------ */
/* Login session manager                                               */
/* ------------------------------------------------------------------ */

type LoginState = 'idle' | 'awaiting' | 'authenticated' | 'failed';

interface LoginStatus {
  state: LoginState;
  signInUrl?: string;
  error?: string;
}

class LoginManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private state: LoginState = 'idle';
  private signInUrl?: string;
  private error?: string;
  private buffer = '';

  /** Start (or reuse) a login flow and resolve once we have the sign-in URL. */
  async start(): Promise<LoginStatus> {
    if (this.state === 'awaiting' && this.signInUrl) {
      return this.status();
    }
    // Reset any previous terminal state and (re)spawn.
    this.cleanup();
    this.state = 'awaiting';
    this.signInUrl = undefined;
    this.error = undefined;
    this.buffer = '';

    const proc = spawn(CLI_PATH, ['auth', 'login', '-j'], { env: cliEnv() });
    this.proc = proc;

    return new Promise<LoginStatus>((resolve) => {
      let resolved = false;
      const settle = () => {
        if (!resolved) {
          resolved = true;
          resolve(this.status());
        }
      };

      const onData = (d: Buffer) => {
        this.buffer += d.toString();
        const json = parseJson<{ signInUrl?: string }>(this.buffer);
        if (json?.signInUrl && !this.signInUrl) {
          this.signInUrl = json.signInUrl;
          settle();
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => (this.buffer += d.toString()));

      proc.on('error', (err) => {
        this.state = 'failed';
        this.error = err.message;
        settle();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.state = 'authenticated';
        } else if (this.state !== 'authenticated') {
          this.state = 'failed';
          this.error =
            this.error || this.buffer.trim() || `Login exited with code ${code}`;
        }
        this.proc = null;
        settle();
      });

      // Safety: if no URL appears in 30s, give up waiting (process may still run).
      setTimeout(settle, 30_000);
    });
  }

  status(): LoginStatus {
    return { state: this.state, signInUrl: this.signInUrl, error: this.error };
  }

  reset() {
    this.cleanup();
    this.state = 'idle';
    this.signInUrl = undefined;
    this.error = undefined;
    this.buffer = '';
  }

  private cleanup() {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGKILL');
    }
    this.proc = null;
  }
}

// Persist across hot-reloads / route module instances in dev.
const g = globalThis as unknown as { __pdLogin?: LoginManager };
export const loginManager = g.__pdLogin ?? (g.__pdLogin = new LoginManager());

/* ------------------------------------------------------------------ */
/* Auth status probe (cached)                                          */
/* ------------------------------------------------------------------ */

let probeCache: { authed: boolean; at: number } | null = null;
const PROBE_TTL = 8_000;

/** True if a Proton session exists. Cheap, cached probe via `filesystem list`. */
export async function isAuthenticated(force = false): Promise<boolean> {
  const loginState = loginManager.status().state;
  if (loginState === 'authenticated') {
    probeCache = { authed: true, at: Date.now() };
    return true;
  }
  // A login is in flight: don't spawn a probe that would race the login process.
  if (loginState === 'awaiting') {
    return false;
  }
  if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL) {
    return probeCache.authed;
  }
  const res = await runCli(['filesystem', 'list', PROTON_ROOT, '-j'], 20_000);
  const authed =
    res.code === 0 && !looksUnauthenticated(res.stdout + res.stderr);
  probeCache = { authed, at: Date.now() };
  return authed;
}

export function clearAuthCache() {
  probeCache = null;
}

let cliVersionCache: string | null = null;
let cliAppVersionCache: string | null = null;

/** The proton-drive CLI version, e.g. "0.4.3". Cached for the process lifetime. */
export async function getCliVersion(): Promise<string> {
  if (cliVersionCache) return cliVersionCache;
  try {
    const res = await runCli(['version'], 15_000);
    // "Proton Drive CLI cli-drive@0.4.3+6a83701" -> 0.4.3
    const m = res.stdout.match(/cli-drive@([0-9][^\s+]*)/);
    cliVersionCache = m?.[1] || res.stdout.trim().split('\n')[0] || 'unknown';
  } catch {
    cliVersionCache = 'unknown';
  }
  return cliVersionCache;
}

/** The full x-pm-appversion the CLI uses, e.g. "cli-drive@0.4.3+6a83701". */
export async function getCliAppVersion(): Promise<string> {
  if (cliAppVersionCache) return cliAppVersionCache;
  try {
    const res = await runCli(['version'], 15_000);
    const m = res.stdout.match(/(cli-drive@[^\s]+)/);
    cliAppVersionCache = m?.[1] || 'cli-drive@0.4.3';
  } catch {
    cliAppVersionCache = 'cli-drive@0.4.3';
  }
  return cliAppVersionCache;
}

/* ------------------------------------------------------------------ */
/* High-level operations                                               */
/* ------------------------------------------------------------------ */

export interface DriveEntry {
  uid: string;
  name: string;
  type: 'file' | 'folder';
  mediaType?: string;
  size?: number;
  /** Claimed modification time in ms (round-trips the local file mtime). */
  mtimeMs?: number;
  /** sha1 of the file content (equals the local file's sha1). */
  sha1?: string;
}

function entryName(raw: any): string {
  if (typeof raw?.name === 'string') return raw.name;
  if (raw?.name && typeof raw.name === 'object') return raw.name.value ?? '';
  return '';
}

/** Normalise a user-supplied Proton path to an absolute /my-files path. */
export function normalizeProtonPath(path: string): string {
  if (!path || path === '/' || path === PROTON_ROOT) return PROTON_ROOT;
  if (path.startsWith(PROTON_ROOT)) return path;
  return `${PROTON_ROOT}/${path.replace(/^\/+/, '')}`;
}

export async function listDrive(path: string): Promise<CliResult<DriveEntry[]>> {
  const full = normalizeProtonPath(path);
  const res = await runJson<any>(['filesystem', 'list', full]);
  if (!res.ok) return res;
  const arr = Array.isArray(res.data) ? res.data : res.data?.items ?? [];
  const entries: DriveEntry[] = (arr as any[]).map((e) => {
    const rev = e.activeRevision?.value ?? e.activeRevision;
    const ct = rev?.claimedModificationTime;
    return {
      uid: e.uid,
      name: entryName(e),
      type: e.type === 'folder' ? 'folder' : 'file',
      mediaType: e.mediaType,
      // claimedSize is the real (decrypted) file size; fall back to storage size.
      size: rev?.claimedSize ?? e.totalStorageSize ?? rev?.storageSize ?? e.size,
      mtimeMs: ct ? Date.parse(ct) : undefined,
      sha1: rev?.claimedDigests?.sha1,
    };
  });
  return { ok: true, data: entries };
}

/**
 * Short-TTL cache over listDrive for UI browsing ONLY - each list spawns a CLI
 * process, so revisiting a folder within the window is served from memory (no
 * spawn, no skeleton on the client's background revalidate). Deliberately NOT
 * used by the delta engine, which needs live server truth for change detection.
 * Invalidated on any folder create/trash and on the deep-refresh resync.
 */
const LIST_TTL = 30_000;
// On globalThis so EVERY Next.js route module instance shares ONE cache: otherwise
// invalidateListCache() (called from the refresh-cache / create / trash routes)
// clears only that route's copy, while the drive/list route keeps serving its own
// stale copy for up to LIST_TTL — i.e. the Refresh button wouldn't actually refresh.
const _lc = globalThis as unknown as { __pdListCache?: Map<string, { data: DriveEntry[]; at: number }> };
const listCache = _lc.__pdListCache ?? (_lc.__pdListCache = new Map());
export function invalidateListCache() {
  listCache.clear();
}

export async function listDriveCached(path: string): Promise<CliResult<DriveEntry[]>> {
  const key = normalizeProtonPath(path);
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL) return { ok: true, data: hit.data };
  const res = await listDrive(path);
  if (res.ok) listCache.set(key, { data: res.data, at: Date.now() });
  return res;
}

export async function createFolder(parentPath: string, name: string) {
  const res = await runJson(['filesystem', 'create-folder', normalizeProtonPath(parentPath), name]);
  invalidateListCache();
  return res;
}

export async function trashDrive(targetPath: string) {
  const res = await runJson(['filesystem', 'trash', normalizeProtonPath(targetPath)]);
  invalidateListCache();
  return res;
}

/**
 * Whether a Drive path exists, checked via `filesystem info` (server truth -
 * unlike `list`, which serves the cached tree). Returns:
 *  - true:  exists
 *  - false: explicitly gone (deleted/trashed externally)
 *  - null:  check failed for another reason (be lenient, don't block backups)
 */
export async function drivePathExists(p: string): Promise<boolean | null> {
  const norm = normalizeProtonPath(p);
  if (norm === PROTON_ROOT) return true; // root always exists
  // Register the probe process so a cancel (killActiveUpload) interrupts it
  // promptly instead of waiting out the timeout. Shorter timeout too — this is
  // a quick metadata lookup, not a transfer.
  let proc: ChildProcessWithoutNullStreams | null = null;
  const res = await runJson(['filesystem', 'info', norm], 30_000, {
    onSpawn: (pr) => {
      proc = pr;
      activeUploads.add(pr);
    },
  });
  if (proc) activeUploads.delete(proc);
  if (res.ok) return true;
  const err = (res.error || '') + (res.raw || '');
  if (/not found|no such|not exist|does not exist|cannot be found/i.test(err)) return false;
  return null;
}

export type FileStrategy = 'merge' | 'keep-both' | 'replace' | 'skip';

/** Parse one verbose stderr line for a per-file upload metric (bytes uploaded). */
function parseUploadMetric(line: string): number | null {
  const m = line.match(/\[metric\] upload (\{.*\})/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    const bytes = j.uploadedSize ?? j.expectedSize;
    return typeof bytes === 'number' ? bytes : null;
  } catch {
    return null;
  }
}

export async function upload(
  localPaths: string[],
  targetPath: string,
  fileStrategy: FileStrategy = 'skip',
  folderStrategy: FileStrategy = 'merge',
  /** If set, the CLI runs verbose and this is called with each file's byte size
      as it completes — used to show live progress/speed during the recursive seed. */
  onUploadedFile?: (bytes: number) => void,
): Promise<RunResult> {
  const args = [
    'filesystem',
    'upload',
    '-f',
    fileStrategy,
    '-d',
    folderStrategy,
    ...localPaths,
    normalizeProtonPath(targetPath),
  ];
  if (onUploadedFile) args.push('-v'); // emit per-file [metric] upload lines
  // Concurrency is managed by the engine's worker pool (and one backup set runs
  // at a time via the runner). No timeout - large files can upload for hours.
  // retryOnLock: a SQLITE_BUSY only hits during the CLI's startup cache init
  // (before bytes are sent), so retrying is cheap and safe under concurrency.
  let proc: ChildProcessWithoutNullStreams | null = null;
  try {
    return await runCli(args, 0, {
      retryOnLock: true,
      onSpawn: (p) => {
        proc = p;
        activeUploads.add(p);
      },
      onStderrLine: onUploadedFile
        ? (line) => {
            const bytes = parseUploadMetric(line);
            if (bytes != null) onUploadedFile(bytes);
          }
        : undefined,
    });
  } finally {
    if (proc) activeUploads.delete(proc);
  }
}
