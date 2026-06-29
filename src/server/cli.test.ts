import { describe, it, expect } from 'vitest';
import {
  normalizeProtonPath,
  looksUnauthenticated,
  cleanCliError,
  parseJson,
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
