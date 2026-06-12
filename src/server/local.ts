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

export interface WalkedFile {
  abs: string;
  /** Path relative to the upload root, starting with the source's basename. */
  rel: string;
  size: number;
  mtimeMs: number;
}

/**
 * Recursively list all files under an absolute source path. A single source
 * file yields one entry (rel = its name); a directory yields its files with
 * rel = "<dirname>/<path-inside>" - mirroring how the CLI lays them on Drive.
 * Hidden dotfiles are skipped (consistent with the browser).
 */
export async function walkSource(absPath: string): Promise<WalkedFile[]> {
  const base = path.basename(absPath);
  let st;
  try {
    st = await fs.stat(absPath);
  } catch {
    return [];
  }
  if (st.isFile()) {
    return [{ abs: absPath, rel: base, size: st.size, mtimeMs: st.mtimeMs }];
  }
  if (!st.isDirectory()) return [];

  const out: WalkedFile[] = [];
  async function recur(dir: string, relPrefix: string) {
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
        await recur(childAbs, childRel);
      } else if (e.isFile()) {
        try {
          const s = await fs.stat(childAbs);
          out.push({ abs: childAbs, rel: childRel, size: s.size, mtimeMs: s.mtimeMs });
        } catch {
          /* unreadable file - skip */
        }
      }
    }
  }
  await recur(absPath, base);
  return out;
}

/**
 * Streaming variant of walkSource: yields one file at a time instead of building
 * the full array. This is what keeps the catalog engine's memory bounded — a
 * 4-million-file source never materialises as a 4-million-element array/Map.
 * Directories are not yielded; the engine derives needed parent folders from
 * each file's rel path.
 */
export async function* walkSourceStream(absPath: string): AsyncGenerator<WalkedFile> {
  const base = path.basename(absPath);
  let st;
  try {
    st = await fs.stat(absPath);
  } catch {
    return;
  }
  if (st.isFile()) {
    yield { abs: absPath, rel: base, size: st.size, mtimeMs: st.mtimeMs };
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
  yield* recur(absPath, base);
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
