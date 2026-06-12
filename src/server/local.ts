import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Browses the local (in-container) filesystem under a configured root.
 * Mount the shares you want to back up under LOCAL_ROOT (default /sources).
 */
export const LOCAL_ROOT = process.env.LOCAL_ROOT || '/sources';

export interface LocalEntry {
  name: string;
  type: 'file' | 'folder';
  size?: number;
  /** Path relative to LOCAL_ROOT, always starting with '/'. */
  path: string;
  absPath: string;
}

/** Resolve a relative path safely inside LOCAL_ROOT (no traversal escape). */
export function resolveLocal(relPath: string): string {
  const clean = path.normalize('/' + (relPath || '')).replace(/^(\.\.(\/|\\|$))+/, '');
  const abs = path.join(LOCAL_ROOT, clean);
  if (abs !== LOCAL_ROOT && !abs.startsWith(LOCAL_ROOT + path.sep)) {
    throw new Error('Path escapes LOCAL_ROOT');
  }
  return abs;
}

/**
 * An absolute source path expressed relative to LOCAL_ROOT, without a leading
 * slash (e.g. /sources/foldera/Fotos → "foldera/Fotos"). This is the structure
 * we mirror on Drive so two same-named folders from different paths never collide.
 */
export function relToLocalRoot(abs: string): string {
  if (abs === LOCAL_ROOT) return '';
  const rel = abs.startsWith(LOCAL_ROOT + path.sep) ? abs.slice(LOCAL_ROOT.length) : abs;
  return rel.replace(/^\/+/, '');
}

/**
 * Reduce an arbitrary string (a backup set's name) to exactly one safe Drive path
 * segment, used as the set's top-level folder. Slashes and control chars become
 * '-', surrounding dots/whitespace are trimmed, and an empty result falls back to
 * 'set' so we always have a usable folder name.
 */
export function sanitizeSegment(name: string): string {
  const seg = (name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\x00-\x1f]+/g, '-') // path separators + control chars -> '-'
    .replace(/^[.\s]+|[.\s]+$/g, ''); // trim leading/trailing dots & whitespace
  return seg || 'set';
}

export interface WalkedFile {
  abs: string;
  /** Path relative to the upload root (the walk's relBase + path inside source). */
  rel: string;
  size: number;
  mtimeMs: number;
}

/**
 * Streaming walk of all files under an absolute source path: yields one file at
 * a time instead of building the full array. Each file's `rel` is `relBase` plus
 * its path inside the source, mirroring how it will be laid out on Drive. The
 * caller controls `relBase` (e.g. "<set-folder>/<source-rel-to-LOCAL_ROOT>") so
 * the destination structure is preserved and same-named folders never collide;
 * it defaults to the source basename for backward compatibility. Hidden dotfiles
 * are skipped (consistent with the browser). This is what keeps the catalog
 * engine's memory bounded — a 4-million-file source never materialises as a
 * 4-million-element array/Map. Directories are not yielded; the engine derives
 * needed parent folders from each file's rel path.
 */
export async function* walkSourceStream(
  absPath: string,
  relBase: string = path.basename(absPath),
): AsyncGenerator<WalkedFile> {
  let st;
  try {
    st = await fs.stat(absPath);
  } catch {
    return;
  }
  if (st.isFile()) {
    yield { abs: absPath, rel: relBase, size: st.size, mtimeMs: st.mtimeMs };
    return;
  }
  if (!st.isDirectory()) return;

  async function* recur(dir: string, relPrefix: string): AsyncGenerator<WalkedFile> {
    let ents;
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const childAbs = path.join(dir, e.name);
      const childRel = `${relPrefix}/${e.name}`;
      if (e.isDirectory()) {
        yield* recur(childAbs, childRel);
      } else if (e.isFile()) {
        let s;
        try {
          s = await fs.stat(childAbs);
        } catch {
          continue; // unreadable file - skip
        }
        yield { abs: childAbs, rel: childRel, size: s.size, mtimeMs: s.mtimeMs };
      }
    }
  }
  yield* recur(absPath, relBase);
}

export async function listLocal(relPath: string): Promise<LocalEntry[]> {
  const abs = resolveLocal(relPath);
  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      // Root not mounted yet - return empty rather than crashing.
      await fs.mkdir(abs, { recursive: true }).catch(() => {});
      return [];
    }
    throw e;
  }

  const entries = await Promise.all(
    dirents
      .filter((d) => !d.name.startsWith('.'))
      .map(async (d) => {
        const childAbs = path.join(abs, d.name);
        const rel = path.relative(LOCAL_ROOT, childAbs);
        const entry: LocalEntry = {
          name: d.name,
          type: d.isDirectory() ? 'folder' : 'file',
          path: '/' + rel,
          absPath: childAbs,
        };
        if (d.isFile()) {
          try {
            entry.size = (await fs.stat(childAbs)).size;
          } catch {
            /* ignore */
          }
        }
        return entry;
      }),
  );

  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
