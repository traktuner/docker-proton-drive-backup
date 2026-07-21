import { describe, it, expect } from 'vitest';
import {
  normalizeProtonPath,
  looksUnauthenticated,
  cleanCliError,
  describeUploadError,
  parseJson,
  cliEnv,
  CACHE_DIR,
  escapeGlobPath,
  buildUploadArgs,
  PROTON_ROOT,
} from '@/server/cli';

describe('normalizeProtonPath', () => {
  it('maps the root-ish inputs to /my-files', () => {
    expect(normalizeProtonPath('/')).toBe('/my-files');
    expect(normalizeProtonPath('')).toBe('/my-files');
    // PROTON_ROOT itself passes through unchanged.
    expect(normalizeProtonPath('/my-files')).toBe('/my-files');
    expect(PROTON_ROOT).toBe('/my-files');
  });

  it('falsy / undefined-ish input also collapses to root', () => {
    // `path` is typed as string, but the guard is `!path`, so empty string covers it.
    expect(normalizeProtonPath('')).toBe('/my-files');
  });

  it('prefixes a bare relative path under /my-files', () => {
    expect(normalizeProtonPath('foo')).toBe('/my-files/foo');
    expect(normalizeProtonPath('foo/bar')).toBe('/my-files/foo/bar');
  });

  it('strips leading slashes before prefixing', () => {
    expect(normalizeProtonPath('/foo')).toBe('/my-files/foo');
    expect(normalizeProtonPath('///foo/bar')).toBe('/my-files/foo/bar');
  });

  it('passes through paths already under /my-files', () => {
    expect(normalizeProtonPath('/my-files/x')).toBe('/my-files/x');
    expect(normalizeProtonPath('/my-files/x/y/z')).toBe('/my-files/x/y/z');
  });

  it('treats a path that merely starts with the root prefix as already-absolute', () => {
    // startsWith is a prefix check, so this is passed through verbatim (current behavior).
    expect(normalizeProtonPath('/my-files-other/x')).toBe('/my-files-other/x');
  });
});

describe('looksUnauthenticated', () => {
  it('matches the known auth-error patterns (case-insensitive)', () => {
    expect(looksUnauthenticated('no session')).toBe(true);
    expect(looksUnauthenticated('Please login first')).toBe(true);
    expect(looksUnauthenticated('Error: not authenticated')).toBe(true);
    expect(looksUnauthenticated('user is not signed in')).toBe(true);
    expect(looksUnauthenticated('ERR_SECRETS could not be read')).toBe(true);
  });

  it('matches when the pattern is embedded in larger noisy text', () => {
    expect(looksUnauthenticated('2024-01-01 [ERROR] No Session available, please login')).toBe(true);
    expect(looksUnauthenticated('{"error":"err_secrets: store missing"}')).toBe(true);
  });

  it('returns false for unrelated text', () => {
    expect(looksUnauthenticated('not found')).toBe(false);
    expect(looksUnauthenticated('file does not exist')).toBe(false);
    expect(looksUnauthenticated('network connection refused')).toBe(false);
    expect(looksUnauthenticated('')).toBe(false);
    expect(looksUnauthenticated('upload complete')).toBe(false);
  });
});

describe('cleanCliError', () => {
  it('maps auth-looking text to a "session expired" message (so reconnect detection fires)', () => {
    const out = cleanCliError('Error: no session found');
    expect(out.toLowerCase()).toContain('session expired');
    expect(cleanCliError('please login').toLowerCase()).toContain('session expired');
    expect(cleanCliError('ERR_SECRETS').toLowerCase()).toContain('session expired');
  });

  it('maps not-found text to a not-found message', () => {
    expect(cleanCliError('node not found')).toBe('Not found on Drive.');
    expect(cleanCliError('no such file')).toBe('Not found on Drive.');
    expect(cleanCliError('the item does not exist')).toBe('Not found on Drive.');
    expect(cleanCliError('cannot be found')).toBe('Not found on Drive.');
  });

  it('maps already-exists / conflict text', () => {
    expect(cleanCliError('a folder already exists')).toBe('An item with that name already exists.');
    expect(cleanCliError('duplicate entry')).toBe('An item with that name already exists.');
    expect(cleanCliError('name conflict detected')).toBe('An item with that name already exists.');
  });

  it('maps timeout text', () => {
    expect(cleanCliError('operation timed out')).toBe('The Drive operation timed out - try again.');
    expect(cleanCliError('request timeout')).toBe('The Drive operation timed out - try again.');
  });

  it('maps network-ish text', () => {
    expect(cleanCliError('network unreachable')).toBe('Network error talking to Proton - try again.');
    expect(cleanCliError('ECONNREFUSED')).toBe('Network error talking to Proton - try again.');
    expect(cleanCliError('getaddrinfo ENOTFOUND')).toBe('Network error talking to Proton - try again.');
    expect(cleanCliError('socket hang up')).toBe('Network error talking to Proton - try again.');
    expect(cleanCliError('dns failure')).toBe('Network error talking to Proton - try again.');
  });

  it('uses a generic fallback for unrecognised text', () => {
    expect(cleanCliError('some weird internal explosion')).toBe('The Drive operation failed.');
  });

  it('handles null / undefined / empty input via the generic fallback', () => {
    expect(cleanCliError(null)).toBe('The Drive operation failed.');
    expect(cleanCliError(undefined)).toBe('The Drive operation failed.');
    expect(cleanCliError('')).toBe('The Drive operation failed.');
  });

  it('never echoes the raw input back to the caller', () => {
    const secret = '/home/app/data/proton/token=ABCDEF123-localpath-leak';
    const out = cleanCliError(secret);
    expect(out).not.toContain('ABCDEF123');
    expect(out).not.toContain('/home/app');
    expect(out).not.toContain('localpath');
    expect(out).toBe('The Drive operation failed.');
  });

  it('auth wins over not-found when both phrases appear (auth checked first)', () => {
    const out = cleanCliError('not found: no session for this user');
    expect(out.toLowerCase()).toContain('session expired');
  });
});

describe('parseJson', () => {
  it('parses output that is entirely one JSON object', () => {
    expect(parseJson('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
  });

  it('parses output that is entirely one JSON array (incl. pretty-printed)', () => {
    expect(parseJson('[1,2,3]')).toEqual([1, 2, 3]);
    const pretty = '[\n  { "uid": "x" },\n  { "uid": "y" }\n]';
    expect(parseJson(pretty)).toEqual([{ uid: 'x' }, { uid: 'y' }]);
  });

  it('extracts JSON embedded in surrounding log noise', () => {
    const raw = 'INFO starting up\n{"signInUrl":"https://proton.me/abc"} trailing log line';
    expect(parseJson(raw)).toEqual({ signInUrl: 'https://proton.me/abc' });
  });

  it('extracts an array embedded in log noise (first bracket to its last match)', () => {
    const raw = 'noise before [{"uid":"a"}] noise after';
    expect(parseJson(raw)).toEqual([{ uid: 'a' }]);
  });

  it('finds a JSON value sitting on its own line amid other output', () => {
    // Designed so the whole-output parse and the bracket-span parse both fail,
    // forcing the line-by-line scan (step 3).
    const raw = [
      'log: object below } stray brace',
      '{"ok":true}',
      'log: another line {oops',
    ].join('\n');
    expect(parseJson(raw)).toEqual({ ok: true });
  });

  it('strips ANSI color escapes before parsing', () => {
    const colored = '\x1b[32m{"colored":true}\x1b[0m';
    expect(parseJson(colored)).toEqual({ colored: true });
  });

  it('returns null for non-JSON output', () => {
    expect(parseJson('just a plain log line, nothing structured')).toBeNull();
    expect(parseJson('not found on drive')).toBeNull();
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(parseJson('')).toBeNull();
    expect(parseJson('   \n  \t ')).toBeNull();
  });

  it('returns null when bracketed text is not valid JSON', () => {
    // Has braces (so step 2 triggers) but the span is not parseable, and no
    // single line is valid JSON either.
    expect(parseJson('start { not really json } end')).toBeNull();
  });

  it('parses a JSON primitive when it is the whole output', () => {
    // The whole-output JSON.parse (step 1) accepts bare primitives.
    expect(parseJson('42')).toBe(42);
    expect(parseJson('true')).toBe(true);
    expect(parseJson('"hello"')).toBe('hello');
  });
});

// Regression guard for issue #19 (read-only start) + running as a non-root `user:`.
// The CLI env is the ONE place HOME is chosen for every spawned proton-drive process;
// the old `/home/app` fallback was a nonexistent dir on the read-only root. HOME must
// fall back to the writable cache dir instead, and must NEVER be /home/app again.
describe('cliEnv – HOME & secret store (issue #19 / non-root)', () => {
  const withHome = (value: string | undefined, fn: () => void) => {
    const saved = process.env.HOME;
    try {
      if (value === undefined) delete process.env.HOME;
      else process.env.HOME = value;
      fn();
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  };

  it('falls back to the writable CACHE_DIR when HOME is unset — never /home/app', () => {
    withHome(undefined, () => {
      const env = cliEnv();
      expect(env.HOME).toBe(CACHE_DIR);
      expect(env.HOME).not.toBe('/home/app');
    });
  });

  it('honours an operator-supplied HOME', () => {
    withHome('/custom/home', () => {
      expect(cliEnv().HOME).toBe('/custom/home');
    });
  });

  it('always uses the file-based secret store pointed at the cache dir (headless-safe)', () => {
    // Guards the headless-Docker contract: no libsecret/keyring, session under CACHE_DIR.
    // CLI 0.6.0 replaced PROTON_DRIVE_UNSAFE_SECRETS=1 with PROTON_DRIVE_CREDENTIALS_STORE
    // (values: keychain | unsafe_file | pass). We must pin "unsafe_file" explicitly —
    // the upstream default is "keychain", which fails with a D-Bus/machine-id error in
    // a container (issue #34).
    const env = cliEnv();
    expect(env.PROTON_DRIVE_CREDENTIALS_STORE).toBe('unsafe_file');
    expect(env.PROTON_DRIVE_CACHE_DIR).toBe(CACHE_DIR);
  });

  it('respects an operator-supplied PROTON_DRIVE_CREDENTIALS_STORE (e.g. "pass")', () => {
    const withCredsStore = (value: string | undefined, fn: () => void) => {
      const saved = process.env.PROTON_DRIVE_CREDENTIALS_STORE;
      try {
        if (value === undefined) delete process.env.PROTON_DRIVE_CREDENTIALS_STORE;
        else process.env.PROTON_DRIVE_CREDENTIALS_STORE = value;
        fn();
      } finally {
        if (saved === undefined) delete process.env.PROTON_DRIVE_CREDENTIALS_STORE;
        else process.env.PROTON_DRIVE_CREDENTIALS_STORE = saved;
      }
    };

    withCredsStore('pass', () => {
      expect(cliEnv().PROTON_DRIVE_CREDENTIALS_STORE).toBe('pass');
    });

    withCredsStore('keychain', () => {
      expect(cliEnv().PROTON_DRIVE_CREDENTIALS_STORE).toBe('keychain');
    });
  });
});

// Regression guard for issue #22: the proton-drive CLI globs positional local paths
// containing * ? [ or {, so a real file named `Movie [1080p].mkv` fails the whole
// upload with "No paths matched". escapeGlobPath neutralises the metacharacters so
// glob() matches the literal file; buildUploadArgs applies it to every source path.
// Per-file upload errors surfaced to the UI (run summary / status toast). The user
// must see WHY a file failed, not a raw CLI dump or a bare count.
describe('describeUploadError (issue #22 — human upload errors)', () => {
  it('maps a globbed-name failure to a human reason', () => {
    expect(describeUploadError('ValidationError: No paths matched: /sources/x')).toMatch(
      /characters the Drive CLI cannot handle/,
    );
  });

  it('maps an over-255 filename to a length reason', () => {
    expect(describeUploadError('Error: name too long')).toMatch(/255 characters/);
    expect(describeUploadError('name exceeds maximum length')).toMatch(/255 characters/);
  });

  it('maps auth, quota and network failures', () => {
    expect(describeUploadError('Error: no session found')).toMatch(/session expired/i);
    expect(describeUploadError('storage is full')).toMatch(/storage is full/i);
    expect(describeUploadError('ECONNRESET while uploading')).toMatch(/network/i);
  });

  it('falls back to the first line of an unknown error and is never empty', () => {
    expect(describeUploadError('weird thing happened\nstack trace…')).toBe('weird thing happened');
    expect(describeUploadError('')).toBe('upload failed');
    expect(describeUploadError(null)).toBe('upload failed');
  });
});

describe('escapeGlobPath (issue #22)', () => {
  it('wraps a bracket in a literal char-class so glob matches the literal name', () => {
    expect(escapeGlobPath('Movie [1080p].mkv')).toBe('Movie [[]1080p].mkv');
  });

  it('escapes each opening metacharacter * ? { individually', () => {
    expect(escapeGlobPath('a*b')).toBe('a[*]b');
    expect(escapeGlobPath('a?b')).toBe('a[?]b');
    expect(escapeGlobPath('a{b,c}d')).toBe('a[{]b,c}d');
  });

  it('leaves a plain path and path separators untouched', () => {
    expect(escapeGlobPath('/sources/folder/file.txt')).toBe('/sources/folder/file.txt');
  });

  it('escapes multiple metacharacters without double-escaping the introduced [', () => {
    // `[` and `*` both present: each original metachar wrapped exactly once.
    expect(escapeGlobPath('x[y]*z')).toBe('x[[]y][*]z');
    // Two brackets → two independent char-classes, no runaway escaping.
    expect(escapeGlobPath('[a][b]')).toBe('[[]a][[]b]');
  });

  it('is idempotent on separators and empty input', () => {
    expect(escapeGlobPath('')).toBe('');
    expect(escapeGlobPath('/')).toBe('/');
  });
});

describe('buildUploadArgs (issue #22)', () => {
  const opts = { fileStrategy: 'merge' as const, folderStrategy: 'merge' as const };

  it('glob-escapes every local source path but NOT the Drive target', () => {
    const args = buildUploadArgs(['/sources/Movie [1080p].mkv', '/sources/plain.txt'], '/Backups', opts);
    expect(args).toContain('/sources/Movie [[]1080p].mkv'); // escaped source
    expect(args).toContain('/sources/plain.txt'); // untouched plain source
    expect(args).toContain('/my-files/Backups'); // normalised target, never escaped
    expect(args.slice(0, 6)).toEqual(['filesystem', 'upload', '-f', 'merge', '-d', 'merge']);
  });

  it('adds -t only when skipThumbnails and -v only when verbose, with -v after the target', () => {
    const plain = buildUploadArgs(['/sources/a.txt'], '/T', opts);
    expect(plain).not.toContain('-t');
    expect(plain).not.toContain('-v');

    const full = buildUploadArgs(['/sources/a.txt'], '/T', { ...opts, skipThumbnails: true, verbose: true });
    expect(full).toContain('-t');
    // -v is the last arg (a global flag accepted after the positionals).
    expect(full[full.length - 1]).toBe('-v');
    expect(full.indexOf('-v')).toBeGreaterThan(full.indexOf('/my-files/T'));
  });
});
