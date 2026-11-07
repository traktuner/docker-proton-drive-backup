import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { SessionFile, parseSession } from './session-store';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pdb-sess-'));
// Exactly what proton-drive CLI 0.5–0.9 write with PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file.
// Fixture values are obviously fake (built at runtime so secret scanners don't flag them).
const FAKE = (k: string) => `fixture-${k}`;
const CLI_FILE = { cachePassword: FAKE('cache'), userKeyPassword: 'ukp', session: { uid: 'u1', accessToken: 'a1', refreshToken: 'r1' }, telemetryEnabled: false };

describe('auth-session.json (CLI format)', () => {
  it('reads a session written by the CLI', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'auth-session.json'), JSON.stringify(CLI_FILE), { mode: 0o600 });
    expect(new SessionFile(d).load()).toEqual(CLI_FILE);
  });

  it('rejects what the CLI rejects', () => {
    expect(parseSession('')).toBeNull();
    expect(parseSession('{')).toBeNull();
    expect(parseSession(JSON.stringify({ ...CLI_FILE, userKeyPassword: '' }))).toBeNull();
    expect(parseSession(JSON.stringify({ ...CLI_FILE, session: { uid: 'u' } }))).toBeNull();
    expect(parseSession(JSON.stringify({ ...CLI_FILE, telemetryEnabled: 'yes' }))).toBeNull();
  });

  it('a token refresh rewrites atomically, 0600, keeping fields it does not own (rollback)', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'auth-session.json'), JSON.stringify({ ...CLI_FILE, futureField: 1 }), { mode: 0o600 });
    const f = new SessionFile(d);
    const s = f.load()!;
    f.save({ ...s, session: { uid: 'u1', accessToken: 'a2', refreshToken: 'r2' } });
    const raw = JSON.parse(fs.readFileSync(path.join(d, 'auth-session.json'), 'utf8'));
    expect(raw).toEqual({ ...CLI_FILE, futureField: 1, session: { uid: 'u1', accessToken: 'a2', refreshToken: 'r2' } });
    expect(fs.statSync(path.join(d, 'auth-session.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(d)).toEqual(['auth-session.json']); // no temp file left behind
    expect(parseSession(JSON.stringify(raw))).not.toBeNull(); // the CLI accepts it again
  });

  it('remove() is idempotent; a missing file means "no session", an unreadable one throws', () => {
    const d = dir();
    const f = new SessionFile(d);
    expect(f.load()).toBeNull();
    f.remove();
    fs.mkdirSync(path.join(d, 'auth-session.json')); // EISDIR: not "logged out"
    expect(() => f.load()).toThrow();
  });
});
