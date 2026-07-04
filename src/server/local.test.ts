import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LOCAL_ROOT,
  resolveLocal,
  relToLocalRoot,
  sanitizeSegment,
  walkSourceStream,
  type WalkedFile,
} from '@/server/local';

// LOCAL_ROOT is set by test/setup.ts to a fresh isolated temp dir and equals
// process.env.LOCAL_ROOT (captured at module-import time).
const ROOT = LOCAL_ROOT;

describe('resolveLocal', () => {
  it('resolves a normal relative path under LOCAL_ROOT', () => {
    expect(resolveLocal('foo/bar')).toBe(path.join(ROOT, 'foo', 'bar'));
    expect(resolveLocal('photos')).toBe(path.join(ROOT, 'photos'));
  });

  it('maps empty / "/" / undefined to LOCAL_ROOT (with a trailing separator)', () => {
    // path.normalize('/' + '') === '/', and path.join(ROOT, '/') keeps a trailing
    // separator, so the result is LOCAL_ROOT + path.sep rather than bare ROOT.
    // Still contained at the root (the guard's `abs === LOCAL_ROOT` is bypassed,
    // but `abs.startsWith(LOCAL_ROOT + path.sep)` holds, so it does not throw).
    expect(resolveLocal('')).toBe(ROOT + path.sep);
    expect(resolveLocal('/')).toBe(ROOT + path.sep);
    // @ts-expect-error exercising the `relPath || ''` fallback for undefined
    expect(resolveLocal(undefined)).toBe(ROOT + path.sep);
  });

  it('a leading slash is normalized away (stays the same as without)', () => {
    expect(resolveLocal('/foo/bar')).toBe(path.join(ROOT, 'foo', 'bar'));
  });

  it('collapses redundant path segments', () => {
    expect(resolveLocal('a/./b')).toBe(path.join(ROOT, 'a', 'b'));
    expect(resolveLocal('a//b')).toBe(path.join(ROOT, 'a', 'b'));
  });

  // The implementation prepends '/' then path.normalize()s, which collapses any
  // '..' that would climb above root before joining with LOCAL_ROOT. As a result
  // these traversal attempts are CONTAINED (re-rooted under LOCAL_ROOT) rather
  // than throwing. The explicit 'Path escapes LOCAL_ROOT' guard is effectively
  // dead for these string inputs — see notes.
  it('contains "../etc/passwd" traversal under LOCAL_ROOT (does not escape)', () => {
    const abs = resolveLocal('../etc/passwd');
    expect(abs).toBe(path.join(ROOT, 'etc', 'passwd'));
    expect(abs.startsWith(ROOT)).toBe(true);
  });

  it('contains "/../../etc" traversal under LOCAL_ROOT', () => {
    const abs = resolveLocal('/../../etc');
    expect(abs).toBe(path.join(ROOT, 'etc'));
    expect(abs.startsWith(ROOT)).toBe(true);
  });

  it('contains "a/../../b" traversal under LOCAL_ROOT', () => {
    const abs = resolveLocal('a/../../b');
    expect(abs).toBe(path.join(ROOT, 'b'));
    expect(abs.startsWith(ROOT)).toBe(true);
  });

  it('contains a deep-climb traversal under LOCAL_ROOT', () => {
    const abs = resolveLocal('../../../../../../etc/shadow');
    expect(abs).toBe(path.join(ROOT, 'etc', 'shadow'));
    expect(abs.startsWith(ROOT)).toBe(true);
  });

  it('partial "..": inner "x/../../../y" is contained, never escapes', () => {
    const abs = resolveLocal('x/../../../y');
    expect(abs.startsWith(ROOT + path.sep) || abs === ROOT).toBe(true);
  });

  it('never returns a path outside LOCAL_ROOT for assorted hostile inputs', () => {
    const hostile = [
      '..',
      '../',
      '../..',
      '../../../../',
      '..%2f..%2fetc', // encoded — treated as a literal segment name, contained
      './../../secret',
    ];
    for (const p of hostile) {
      const abs = resolveLocal(p);
      expect(abs === ROOT || abs.startsWith(ROOT + path.sep)).toBe(true);
    }
  });
});

describe('relToLocalRoot', () => {
  it('returns the relative path without a leading slash for an abs under root', () => {
    expect(relToLocalRoot(path.join(ROOT, 'foldera', 'Fotos'))).toBe(
      path.join('foldera', 'Fotos'),
    );
    expect(relToLocalRoot(path.join(ROOT, 'a'))).toBe('a');
  });

  it('returns "" for LOCAL_ROOT itself', () => {
    expect(relToLocalRoot(ROOT)).toBe('');
  });

  it('leaves a path that is not under LOCAL_ROOT as-is (minus leading slashes)', () => {
    // Not under root: returned unchanged except leading slashes stripped.
    expect(relToLocalRoot('/somewhere/else')).toBe('somewhere/else');
  });

  it('round-trips with resolveLocal for a normal nested path', () => {
    const abs = resolveLocal('foldera/Fotos');
    expect(relToLocalRoot(abs)).toBe(path.join('foldera', 'Fotos'));
  });
});

describe('sanitizeSegment', () => {
  it('leaves a normal name unchanged', () => {
    expect(sanitizeSegment('Photos')).toBe('Photos');
    expect(sanitizeSegment('My Backup 2024')).toBe('My Backup 2024');
  });

  it('replaces slashes (both kinds) with "-"', () => {
    expect(sanitizeSegment('a/b')).toBe('a-b');
    expect(sanitizeSegment('a\\b')).toBe('a-b');
    expect(sanitizeSegment('a/b/c')).toBe('a-b-c');
    // runs of separators collapse to a single '-'
    expect(sanitizeSegment('a///b')).toBe('a-b');
  });

  it('replaces control chars with "-"', () => {
    expect(sanitizeSegment('a\x00b')).toBe('a-b');
    expect(sanitizeSegment('a\tb')).toBe('a-b');
    expect(sanitizeSegment('a\nb')).toBe('a-b');
    expect(sanitizeSegment('a\x1fb')).toBe('a-b');
  });

  it('trims leading/trailing dots and whitespace', () => {
    expect(sanitizeSegment('  Photos  ')).toBe('Photos');
    expect(sanitizeSegment('...Photos...')).toBe('Photos');
    expect(sanitizeSegment(' .Photos. ')).toBe('Photos');
    expect(sanitizeSegment('Photos.')).toBe('Photos');
    expect(sanitizeSegment('.Photos')).toBe('Photos');
  });

  it('keeps a leading dash (e.g. "-rf" is NOT stripped)', () => {
    expect(sanitizeSegment('-rf')).toBe('-rf');
    expect(sanitizeSegment('--flag')).toBe('--flag');
  });

  it('falls back to "set" for empty / whitespace-only / dot-only / falsy input', () => {
    expect(sanitizeSegment('')).toBe('set');
    expect(sanitizeSegment('   ')).toBe('set');
    expect(sanitizeSegment('...')).toBe('set');
    expect(sanitizeSegment('. . .')).toBe('set');
    // @ts-expect-error exercising the `name || ''` fallback
    expect(sanitizeSegment(undefined)).toBe('set');
    // @ts-expect-error exercising the `name || ''` fallback
    expect(sanitizeSegment(null)).toBe('set');
  });

  it('a string made only of separators collapses to "-" (a single dash, not "set")', () => {
    // The dash is not a trimmable char, so the fallback does not kick in.
    expect(sanitizeSegment('/')).toBe('-');
    expect(sanitizeSegment('///')).toBe('-');
  });
});

// ---- walkSourceStream fixtures ----

async function collect(gen: AsyncGenerator<WalkedFile>): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

/** Build a fixture tree under a fresh subdir of LOCAL_ROOT; return its abs path. */
async function makeTree(name: string): Promise<string> {
  const base = path.join(ROOT, name);
  await fs.mkdir(path.join(base, 'sub'), { recursive: true });
  await fs.mkdir(path.join(base, '.hiddenDir'), { recursive: true });
  await fs.writeFile(path.join(base, 'a.txt'), 'hello'); // 5 bytes
  await fs.writeFile(path.join(base, 'b.txt'), 'world!!'); // 7 bytes
  await fs.writeFile(path.join(base, '.dotfile'), 'secret'); // skipped
  await fs.writeFile(path.join(base, 'sub', 'c.txt'), 'abc'); // 3 bytes
  await fs.writeFile(path.join(base, '.hiddenDir', 'nope.txt'), 'x'); // under dotdir
  return base;
}

describe('walkSourceStream', () => {
  it('yields all non-hidden files with correct rel + size, skipping dotfiles', async () => {
    const base = await makeTree('walk-basic');
    const files = await collect(walkSourceStream(base));

    const byRel = new Map(files.map((f) => [f.rel, f]));
    const rels = [...byRel.keys()].sort();

    // Default relBase is the basename of the source dir.
    expect(rels).toEqual([
      'walk-basic/a.txt',
      'walk-basic/b.txt',
      'walk-basic/sub/c.txt',
    ]);

    expect(byRel.get('walk-basic/a.txt')!.size).toBe(5);
    expect(byRel.get('walk-basic/b.txt')!.size).toBe(7);
    expect(byRel.get('walk-basic/sub/c.txt')!.size).toBe(3);

    // No dotfiles and nothing under a dot-directory.
    expect(rels.some((r) => r.includes('.dotfile'))).toBe(false);
    expect(rels.some((r) => r.includes('.hiddenDir'))).toBe(false);
    expect(rels.some((r) => r.includes('nope.txt'))).toBe(false);
  });

  it('exposes abs + mtimeMs and abs points at the real file', async () => {
    const base = await makeTree('walk-meta');
    const files = await collect(walkSourceStream(base));
    const a = files.find((f) => f.rel.endsWith('/a.txt'))!;
    expect(a.abs).toBe(path.join(base, 'a.txt'));
    expect(typeof a.mtimeMs).toBe('number');
    expect(a.mtimeMs).toBeGreaterThan(0);
    const content = await fs.readFile(a.abs, 'utf8');
    expect(content).toBe('hello');
  });

  it('respects a custom relBase (mirrors Drive destination layout)', async () => {
    const base = await makeTree('walk-relbase');
    const files = await collect(walkSourceStream(base, 'SetFolder/sub-source'));
    const rels = files.map((f) => f.rel).sort();
    expect(rels).toEqual([
      'SetFolder/sub-source/a.txt',
      'SetFolder/sub-source/b.txt',
      'SetFolder/sub-source/sub/c.txt',
    ]);
  });

  it('yields a single entry (rel = relBase) when the source is a file', async () => {
    const filePath = path.join(ROOT, 'single.bin');
    await fs.writeFile(filePath, 'abcd'); // 4 bytes
    const files = await collect(walkSourceStream(filePath));
    expect(files).toHaveLength(1);
    expect(files[0].rel).toBe('single.bin'); // default relBase = basename
    expect(files[0].abs).toBe(filePath);
    expect(files[0].size).toBe(4);
  });

  it('uses the provided relBase for a single-file source', async () => {
    const filePath = path.join(ROOT, 'single2.bin');
    await fs.writeFile(filePath, 'xy'); // 2 bytes
    const files = await collect(walkSourceStream(filePath, 'Custom/Name'));
    expect(files).toHaveLength(1);
    expect(files[0].rel).toBe('Custom/Name');
    expect(files[0].size).toBe(2);
  });

  it('yields nothing for a non-existent path', async () => {
    const files = await collect(
      walkSourceStream(path.join(ROOT, 'does-not-exist-xyz')),
    );
    expect(files).toEqual([]);
  });

  it('yields nothing for an empty directory', async () => {
    const empty = path.join(ROOT, 'empty-dir');
    await fs.mkdir(empty, { recursive: true });
    const files = await collect(walkSourceStream(empty));
    expect(files).toEqual([]);
  });

  it('yields nothing for a directory that contains only hidden entries', async () => {
    const base = path.join(ROOT, 'only-hidden');
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, '.a'), '1');
    await fs.writeFile(path.join(base, '.b'), '2');
    const files = await collect(walkSourceStream(base));
    expect(files).toEqual([]);
  });

  it('includeHidden: also yields dotfiles and files under dot-directories', async () => {
    const base = await makeTree('walk-hidden');
    const rels = (await collect(walkSourceStream(base, 'walk-hidden', { includeHidden: true })))
      .map((f) => f.rel)
      .sort();
    expect(rels).toEqual([
      'walk-hidden/.dotfile',
      'walk-hidden/.hiddenDir/nope.txt',
      'walk-hidden/a.txt',
      'walk-hidden/b.txt',
      'walk-hidden/sub/c.txt',
    ]);
  });

  it('onSkip: reports an unreadable folder instead of dropping it silently', async () => {
    // stat/read perms don't apply to root, so skip there (CI often runs as root).
    if (process.getuid?.() === 0) return;
    const base = path.join(ROOT, 'walk-locked');
    const locked = path.join(base, 'locked');
    await fs.mkdir(locked, { recursive: true });
    await fs.writeFile(path.join(base, 'ok.txt'), 'ok');
    await fs.writeFile(path.join(locked, 'secret.txt'), 's');
    await fs.chmod(locked, 0o000); // remove read+exec so readdir(locked) fails

    const skips: { rel: string; reason: string }[] = [];
    let files: WalkedFile[] = [];
    try {
      files = await collect(walkSourceStream(base, 'walk-locked', { onSkip: (rel, reason) => skips.push({ rel, reason }) }));
    } finally {
      await fs.chmod(locked, 0o755); // restore so the test dir can be cleaned up
    }

    // The readable file still comes through; the locked folder is surfaced, not lost.
    expect(files.map((f) => f.rel)).toContain('walk-locked/ok.txt');
    expect(skips.some((s) => s.rel.includes('locked'))).toBe(true);
    expect(skips.find((s) => s.rel.includes('locked'))!.reason).toMatch(/folder not readable/);
  });
});
