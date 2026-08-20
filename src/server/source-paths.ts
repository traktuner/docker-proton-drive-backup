import path from 'node:path';
import {
  accessSync,
  constants,
  lstatSync,
  promises as fs,
  statSync,
} from 'node:fs';
import { LOCAL_ROOT, resolveLocal } from './local';

export const MAX_SOURCES_PER_SET = 256;
const MAX_SOURCE_PATH_LENGTH = 4096;

export class SourceValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Resolve relative browser paths and stored absolute paths under LOCAL_ROOT. */
export function resolveSourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SourceValidationError('Every source must be a non-empty path.');
  }
  if (value.length > MAX_SOURCE_PATH_LENGTH || value.includes('\0')) {
    throw new SourceValidationError('A selected source path is invalid.');
  }

  const raw = value.trim();
  const root = path.resolve(LOCAL_ROOT);
  const candidate =
    raw === LOCAL_ROOT || raw.startsWith(LOCAL_ROOT + path.sep)
      ? path.resolve(raw)
      : path.resolve(resolveLocal(raw));

  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new SourceValidationError('A selected source is outside the configured source root.');
  }
  return candidate;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

/**
 * Validate a list of NEW roots against the set's existing roots.
 *
 * Source editing is additive only. Overlaps are rejected because scanning both a
 * parent and its child can queue the same file twice before the catalog flushes.
 */
export function planSourceAdditions(existing: string[], requested: unknown[]): string[] {
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new SourceValidationError('Select at least one source to add.');
  }
  if (existing.length + requested.length > MAX_SOURCES_PER_SET) {
    throw new SourceValidationError(`A backup set can contain at most ${MAX_SOURCES_PER_SET} sources.`);
  }

  const existingCanonical = existing.map((p) => path.resolve(p));
  const additions: string[] = [];
  for (const value of requested) {
    const candidate = resolveSourcePath(value);
    const existingOverlap = existingCanonical.find((p) => overlaps(p, candidate));
    if (existingOverlap) {
      const exact = existingOverlap === candidate;
      throw new SourceValidationError(
        exact
          ? 'This source already belongs to the backup set.'
          : 'This source overlaps an existing source. Select a separate folder instead.',
        409,
      );
    }
    if (additions.some((p) => overlaps(p, candidate))) {
      throw new SourceValidationError('The selected sources overlap each other.', 409);
    }
    additions.push(candidate);
  }
  return additions;
}

/** Verify that every new root is currently readable and is a file or directory. */
export async function verifySourceAdditions(additions: string[]): Promise<void> {
  for (const source of additions) {
    let stat;
    let linkStat;
    try {
      linkStat = await fs.lstat(source);
      stat = await fs.stat(source);
      await fs.access(source, constants.R_OK);
    } catch {
      throw new SourceValidationError(`Source “${source}” is missing or not readable.`);
    }
    if (linkStat.isSymbolicLink()) {
      throw new SourceValidationError(`Source “${source}” is a symbolic link. Select its real folder instead.`);
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new SourceValidationError(`Source “${source}” is not a regular file or folder.`);
    }
  }
}

/** Synchronous variant for the synchronous declarative-config import path. */
export function verifySourceAdditionsSync(additions: string[]): void {
  for (const source of additions) {
    let stat;
    let linkStat;
    try {
      linkStat = lstatSync(source);
      stat = statSync(source);
      accessSync(source, constants.R_OK);
    } catch {
      throw new SourceValidationError(`Source “${source}” is missing or not readable.`);
    }
    if (linkStat.isSymbolicLink()) {
      throw new SourceValidationError(`Source “${source}” is a symbolic link. Select its real folder instead.`);
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new SourceValidationError(`Source “${source}” is not a regular file or folder.`);
    }
  }
}

export type SourceListChange =
  | { kind: 'same'; additions: [] }
  | { kind: 'additive'; additions: string[] }
  | { kind: 'destructive'; additions: string[]; removed: string[] };

/** Classify a full imported source list without changing stored source order. */
export function classifySourceListChange(existing: string[], next: string[]): SourceListChange {
  const existingCanonical = existing.map((p) => path.resolve(p));
  const nextCanonical = next.map((p) => path.resolve(p));
  const additions = next.filter((_, i) => !existingCanonical.includes(nextCanonical[i]));
  const removed = existing.filter((_, i) => !nextCanonical.includes(existingCanonical[i]));
  if (removed.length > 0) return { kind: 'destructive', additions, removed };
  if (additions.length === 0) return { kind: 'same', additions: [] };
  return { kind: 'additive', additions };
}
