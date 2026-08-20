import { backupSets } from '@/server/db';
import { isBackupSetBusy } from '@/server/backup-lock';
import {
  planSourceAdditions,
  SourceValidationError,
  verifySourceAdditions,
} from '@/server/source-paths';
import { relToLocalRoot } from '@/server/local';

export const dynamic = 'force-dynamic';

const MAX_ADDITIONAL_EXCLUDES = 1024;
const MAX_EXCLUDE_LENGTH = 1024;

function parseAdditionalExcludes(value: unknown, additions: string[]): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ADDITIONAL_EXCLUDES) {
    throw new SourceValidationError('The selected exclusions are invalid.');
  }
  const excludes = value.map((item) => {
    if (typeof item !== 'string' || item.length > MAX_EXCLUDE_LENGTH) {
      throw new SourceValidationError('The selected exclusions are invalid.');
    }
    return item.trim();
  });
  const unique = [...new Set(excludes.filter(Boolean))];
  const roots = additions.map((source) => relToLocalRoot(source).replace(/\\/g, '/'));
  for (const pattern of unique) {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\/+/, '');
    const belongsToAddition = roots.some(
      (root) => root === '' || normalized === root || normalized.startsWith(`${root}/`),
    );
    if (!belongsToAddition) {
      throw new SourceValidationError('A selected exclusion is outside the new sources.');
    }
  }
  return unique;
}

/** Add source roots without removing or rewriting any existing root or catalog row. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = backupSets.get(id);
  if (!current) return Response.json({ error: 'not found' }, { status: 404 });
  if (current.lastStatus === 'running' || isBackupSetBusy(id)) {
    return Response.json(
      { error: 'Pause or stop this backup before adding sources.' },
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  let additions: string[];
  let additionalExcludes: string[];
  try {
    additions = planSourceAdditions(current.sourcePaths, body.sourcePaths as unknown[]);
    additionalExcludes = parseAdditionalExcludes(body.excludes, additions);
    await verifySourceAdditions(additions);
  } catch (error) {
    const validation = error instanceof SourceValidationError ? error : null;
    return Response.json(
      { error: validation?.message || 'Invalid source selection.' },
      { status: validation?.status || 400 },
    );
  }

  // Filesystem checks await I/O. Re-read and revalidate after that await so a
  // concurrent edit or newly queued scheduler run cannot slip past stale state.
  const latest = backupSets.get(id);
  if (!latest) return Response.json({ error: 'not found' }, { status: 404 });
  if (latest.lastStatus === 'running' || isBackupSetBusy(id)) {
    return Response.json(
      { error: 'The backup started while sources were being checked. Pause or stop it, then try again.' },
      { status: 409 },
    );
  }

  try {
    additions = planSourceAdditions(latest.sourcePaths, additions);
  } catch (error) {
    const validation = error instanceof SourceValidationError ? error : null;
    return Response.json(
      { error: validation?.message || 'The source list changed. Refresh and try again.' },
      { status: validation?.status || 409 },
    );
  }

  const updated = backupSets.appendSourcesIfStopped(id, additions, additionalExcludes);
  if (!updated) {
    return Response.json(
      { error: 'The backup is no longer stopped. Pause or stop it, then try again.' },
      { status: 409 },
    );
  }

  return Response.json({ backupSet: updated, added: additions.length });
}
