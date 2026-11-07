import fs from 'node:fs';
import path from 'node:path';

/**
 * The Proton session on disk, in EXACTLY the format the official proton-drive CLI
 * writes with PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file:
 *
 *   <sessionDir>/auth-session.json  (mode 0600)
 *   { "cachePassword"?: string, "userKeyPassword": string,
 *     "session": { "uid": string, "accessToken": string, "refreshToken"?: string },
 *     "telemetryEnabled"?: boolean }
 *
 * Keeping the format is what makes both directions of the upgrade work:
 *   - upgrade: the SDK release picks up the session every CLI-era install has,
 *     no re-login and no extra mounts;
 *   - rollback: after the SDK release refreshed the tokens (refresh tokens are
 *     single-use and rotate), the CLI-era image reads the CURRENT tokens from the
 *     same file instead of a stale copy Proton already invalidated.
 *
 * Unknown fields (e.g. the CLI's cachePassword, which encrypts the CLI's own
 * cache files) are preserved on every write. Writes are atomic (temp file in the
 * same directory + fsync + rename), so a crash mid-write can never leave a
 * truncated session behind — the old CLI wrote in place.
 */

const SESSION_FILE = 'auth-session.json';

export interface StoredSession {
  userKeyPassword: string;
  session: { uid: string; accessToken: string; refreshToken?: string };
  cachePassword?: string;
  telemetryEnabled?: boolean;
  [extra: string]: unknown;
}

/** Same acceptance rules as the CLI's parseStoredSnapshot (cli/src/credentials). */
export function parseSession(raw: string | null | undefined): StoredSession | null {
  if (raw == null || raw === '') return null;
  let s: StoredSession;
  try {
    s = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !s ||
    typeof s !== 'object' ||
    (s.cachePassword !== undefined && s.cachePassword !== null && typeof s.cachePassword !== 'string') ||
    typeof s.userKeyPassword !== 'string' ||
    !s.userKeyPassword ||
    typeof s.session?.uid !== 'string' ||
    !s.session.uid ||
    typeof s.session?.accessToken !== 'string' ||
    !s.session.accessToken ||
    (s.session.refreshToken !== undefined && s.session.refreshToken !== null && typeof s.session.refreshToken !== 'string') ||
    (s.telemetryEnabled !== undefined && typeof s.telemetryEnabled !== 'boolean')
  ) {
    return null;
  }
  return s;
}

export class SessionFile {
  readonly file: string;
  /** Raw object as last read/written, so unknown fields survive a rewrite. */
  private last: Record<string, unknown> = {};

  constructor(readonly dir: string) {
    this.file = path.join(dir, SESSION_FILE);
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  load(): StoredSession | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e; // EACCES etc. is a real problem, not "logged out"
    }
    const s = parseSession(raw);
    if (s) this.last = { ...s };
    return s;
  }

  save(s: StoredSession): void {
    const out = { ...this.last, ...s };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `.${SESSION_FILE}.${process.pid}.tmp`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(out));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600); // best-effort on chmod-less mounts
    } catch {
      /* ignore */
    }
    this.last = out;
  }

  remove(): void {
    this.last = {};
    try {
      fs.unlinkSync(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
