import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { type NodeEntity, NodeType, NodeWithSameNameExistsValidationError } from '@protontech/drive-sdk';
import { generateAdditionalNodeMetadata } from '@protontech/drive-sdk/additionalNodeMetadata';

import { generateThumbnails } from '../commands/fileSystem/generateThumbnails';
import { getLocalFileMediaType } from '../commands/fileSystem/mediaType';
import type { init } from '../init';

type Context = Pick<Awaited<ReturnType<typeof init>>, 'sdk' | 'logger'>;
type UploadParams = {
  sources: string[];
  fileStrategy: string;
  folderStrategy: string;
  skipThumbnails: boolean;
  includeHidden?: boolean;
};

export async function upload(
  ctx: Context,
  params: UploadParams,
  signal: AbortSignal,
  progress: (bytes: number) => void,
  target: NodeEntity,
) {
  const { sdk, logger } = ctx;
  if (!params.sources.length) throw new Error('No upload sources');
  if (params.folderStrategy !== 'merge' || !['skip', 'create-new-revision'].includes(params.fileStrategy)) {
    throw new Error('Unsupported backup conflict strategy');
  }
  signal.throwIfAborted();
  const sourceRoot = await realpath(process.env.LOCAL_ROOT || '/sources');
  if (target.type !== NodeType.Folder) throw new Error('Upload destination is not a folder');
  let uploaded = 0;
  let skipped = 0;

  async function ensureFolder(parent: NodeEntity, name: string) {
    try {
      return await sdk.createFolder(parent, name);
    } catch (error) {
      if (!(error instanceof NodeWithSameNameExistsValidationError) || error.isUnfinishedUpload || !error.existingNodeUid) throw error;
      const existing = await sdk.getNode(error.existingNodeUid);
      if (existing.type !== NodeType.Folder) throw new Error(`Cannot merge folder "${name}" into a file`);
      return existing;
    }
  }

  // Keep an open descriptor while hashing, generating previews and streaming. On
  // Linux /proc/self/fd also pins parent directories across renames during a walk.
  async function visit(localPath: string, name: string, parent: NodeEntity): Promise<void> {
    signal.throwIfAborted();
    const handle = await open(localPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const fdPath = `/proc/self/fd/${handle.fd}`;
      const actual = await realpath(fdPath);
      const relative = path.relative(sourceRoot, actual);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Upload source escapes LOCAL_ROOT');
      }
      const stat = await handle.stat();
      if (stat.isDirectory()) {
        const folder = await ensureFolder(parent, name);
        for await (const child of await opendir(fdPath)) {
          signal.throwIfAborted();
          if (!params.includeHidden && child.name.startsWith('.')) continue;
          await visit(path.join(fdPath, child.name), child.name, folder);
        }
        return;
      }
      if (!stat.isFile()) throw new Error(`Not a regular file: "${name}"`);
      const hash = createHash('sha1');
      for await (const chunk of createReadStream(fdPath, { signal })) hash.update(chunk);
      const expectedSha1 = hash.digest('hex');
      const file = Bun.file(fdPath);
      const mediaType = getLocalFileMediaType(logger, name);
      const metadata = {
        mediaType, expectedSize: stat.size, expectedSha1, modificationTime: stat.mtime,
        ...(await generateAdditionalNodeMetadata(file, mediaType, undefined, logger)),
      };
      const thumbnails = params.skipThumbnails ? [] : await generateThumbnails(mediaType, fdPath);
      signal.throwIfAborted();

      async function transfer(revisionOf?: string) {
        signal.throwIfAborted();
        // The SDK attaches listeners to its signal. Detach the per-file scope
        // after completion so a large recursive job does not retain past uploads.
        const active = new AbortController();
        const abort = () => active.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        try {
          const uploader = revisionOf
            ? await sdk.getFileRevisionUploader(revisionOf, metadata, active.signal)
            : await sdk.getFileUploader(parent, name, metadata, active.signal);
          const stream = file.stream();
          try {
            const controller = await uploader.uploadFromStream(stream, thumbnails);
            const committed = await controller.completion();
            if (!committed.nodeUid || !committed.nodeRevisionUid || (revisionOf && revisionOf !== committed.nodeUid)) {
              throw new Error(`Missing or inconsistent upload confirmation for "${name}"`);
            }
          } finally {
            if (!stream.locked) await stream.cancel().catch(() => {});
          }
        } finally {
          signal.removeEventListener('abort', abort);
        }
      }

      try {
        await transfer();
      } catch (error) {
        if (!(error instanceof NodeWithSameNameExistsValidationError) || error.isUnfinishedUpload || !error.existingNodeUid) throw error;
        signal.throwIfAborted();
        const existing = await sdk.getNode(error.existingNodeUid);
        if (existing.type !== NodeType.File) throw new Error(`Cannot upload file "${name}" over a folder`);
        if (params.fileStrategy === 'skip' || existing.activeRevision?.claimedDigests?.sha1 === expectedSha1) {
          skipped++;
          return;
        }
        await transfer(existing.uid);
      }
      uploaded++;
      progress(stat.size);
    } finally {
      await handle.close();
    }
  }

  // The caller bounds parallel upload requests. Inside a request, keep at most
  // one content stream plus the current traversal's directory handles alive.
  for (const source of params.sources) {
    if (!path.isAbsolute(source)) throw new Error('Expected an absolute local source');
    await visit(source, path.basename(source), target);
  }
  return { uploaded, skipped };
}
