import { NodeType, type NodeEntity } from '@protontech/drive-sdk';
import type { init } from '../init';

type Context = Pick<Awaited<ReturnType<typeof init>>, 'sdk' | 'caches' | 'paths'>;
const root = '/my-files';

export class DriveError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'UNAUTHENTICATED',
    message: string,
  ) {
    super(message);
  }
}

export function validName(name: string) {
  if (name === '.' || name === '..' || !name || /[\/\0]/.test(name)) throw new Error('Invalid Drive name');
  return name;
}

export function segments(path: string) {
  if (path === root) return [];
  if (!path.startsWith(root + '/')) throw new Error('Path must be in My files');
  return path
    .slice(root.length + 1)
    .split('/')
    .map(validName);
}

// Traverse by literal decrypted name. The client's generic path helper also accepts
// node UIDs in path components, which is inappropriate for NAS filenames.
export async function resolve(ctx: Context, path: string, confirm = false) {
  const parts = segments(path);
  let current = await ctx.paths.getNode(root);
  for (const part of parts) {
    let child: NodeEntity | undefined;
    for await (const candidate of ctx.sdk.iterateFolderChildren(current)) {
      if (!candidate.name.ok || candidate.name.value !== part) continue;
      let match = candidate;
      if (confirm) {
        // Proton's pinned NodesCache uses node-<UID> for metadata.
        // Fetch this specific node again before mutating by UID: a rename
        // followed by another file taking the old name leaves membership intact.
        await ctx.caches.entitiesCache.removeEntities(['node-' + candidate.uid]);
        match = await ctx.sdk.getNode(candidate.uid);
        if (!match.name.ok || match.name.value !== part || match.parentUid !== current.uid || match.trashTime)
          continue;
      }
      child = match;
      break;
    }
    // Listing membership is live, but decrypted names can be cached until the
    // next event. Check the name hash on the server before declaring it absent.
    if (!child) {
      if ((await ctx.sdk.getAvailableName(current, part, NodeType.Folder)) === part) {
        throw new DriveError('NOT_FOUND', 'Drive path not found');
      }
      throw new Error('Cannot verify the Drive path against its encrypted name');
    }
    current = child;
  }
  return current;
}
