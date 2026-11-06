import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DriveEntry, FileStrategy, FolderStrategy } from './cli';

export const sdkEnabled = () => process.env.DRIVE_BACKEND === 'sdk';
type LoginState = 'idle' | 'awaiting' | 'authenticated' | 'failed';
export type SdkLogin = { state: LoginState; signInUrl?: string; error?: string };
export type SdkStatus = { authenticated: boolean; loginState: LoginState; error?: string };

type Operations = {
  status: [object, SdkStatus];
  login: [object, SdkLogin];
  logout: [object, unknown];
  list: [{ path: string }, DriveEntry[]];
  mkdir: [{ parentPath: string; name: string; existingOk: boolean }, unknown];
  trash: [{ path: string }, unknown];
  rename: [{ path: string; name: string }, unknown];
  exists: [{ path: string }, boolean | null];
  quota: [object, { User?: {
    MaxSpace: number; UsedSpace: number; ProductUsedSpace?: Record<string, number>;
    Email?: string; DisplayName?: string; Name?: string;
  } }];
  refresh: [object, unknown];
  upload: [{
    sources: string[]; dest: string; fileStrategy: FileStrategy; folderStrategy: FolderStrategy;
    skipThumbnails: boolean; includeHidden: boolean;
  }, unknown];
  cancel: [object, unknown];
  version: [object, { appVersion: string; sdkVersion: string }];
};
type Pending = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  progress?: (bytes: number) => void;
  timeout?: NodeJS.Timeout;
};

export class SdkError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

/** One worker owns the session, event subscriptions and crypto caches. A crash
 * fails in-flight requests. Mutations are never replayed by this transport. */
export class SdkWorker {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  private start() {
    if (this.child) return this.child;
    const child = spawn(process.env.DRIVE_SDK_WORKER || '/usr/local/bin/drive-sdk-worker', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    const fail = (message: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      child.kill('SIGKILL');
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error(message));
      }
      this.pending.clear();
    };
    // Protocol errors must never echo a line containing credentials or the sign-in URL.
    // The worker's own logger handles diagnostics; drain stderr without publishing it.
    child.stderr.resume();
    child.on('error', () => fail('Could not start the Proton Drive SDK worker.'));
    child.stdin.on('error', () => fail('Lost connection to the Proton Drive SDK worker.'));
    child.on('close', () => fail('The Proton Drive SDK worker stopped.'));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child) return;
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        return fail('Invalid response from the Proton Drive SDK worker.');
      }
      if (!reply || typeof reply !== 'object') return fail('Invalid SDK worker response.');
      const request = this.pending.get(reply.id);
      if (!request) return;
      if (typeof reply.progress === 'number') {
        if (Number.isSafeInteger(reply.progress) && reply.progress >= 0) request.progress?.(reply.progress);
        return;
      }
      clearTimeout(request.timeout);
      this.pending.delete(reply.id);
      if (typeof reply.error === 'string') {
        const message = reply.code === 'UNAUTHENTICATED' ? 'Not authenticated. Reconnect to Proton Drive.' : reply.error;
        request.reject(new SdkError(message, reply.code));
      } else if ('result' in reply) {
        request.resolve(reply.result);
      } else {
        request.reject(new Error('Incomplete response from the Proton Drive SDK worker.'));
      }
    });
    return child;
  }

  call<M extends keyof Operations>(method: M, params: Operations[M][0], progress?: (bytes: number) => void) {
    const child = this.start();
    const id = ++this.nextId;
    return new Promise<Operations[M][1]>((resolve, reject) => {
      const request: Pending = { resolve: value => resolve(value as Operations[M][1]), reject, progress };
      // File transfers can legitimately take hours. Cancelling an unresponsive
      // worker closes all outstanding operations before the next backup can start.
      if (method !== 'upload') {
        request.timeout = setTimeout(() => {
          this.pending.delete(id);
          if (method === 'cancel' || method === 'logout') child.kill('SIGKILL');
          reject(new Error('The Proton Drive SDK request timed out.'));
        }, method === 'cancel' ? 10_000 : 120_000);
      }
      this.pending.set(id, request);
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
}

// Next's API route bundles can load this module more than once.
const globals = globalThis as typeof globalThis & { __pdSdkWorker?: SdkWorker };
export const sdkWorker = globals.__pdSdkWorker ??= new SdkWorker();
