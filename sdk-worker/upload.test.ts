// Run in the pinned Proton source tree, like upload.ts itself.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeType, NodeWithSameNameExistsValidationError, type NodeEntity, type Thumbnail, type UploadMetadata } from '@protontech/drive-sdk';
import { upload } from './upload';

let root: string;
const previousRoot = process.env.LOCAL_ROOT;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sdk-upload-'));
  process.env.LOCAL_ROOT = root;
});
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_ROOT;
  else process.env.LOCAL_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

// Transport stub checks the real Linux stream and what the worker claimed to the SDK.
function drive(beforeCommit?: (signal: AbortSignal) => Promise<void>) {
  type Item = { uid: string; type: NodeType; activeRevision?: { claimedDigests: { sha1: string } } };
  const nodes = new Map<string, Item>();
  const target = { uid: '/target', type: NodeType.Folder } as NodeEntity;
  const commits: string[] = [];
  const thumbnailSizes: number[] = [];
  const failOn = new Set<string>();
  const conflict = (uid: string) => new NodeWithSameNameExistsValidationError('Name conflict', 0, uid);
  function writer(uid: string, metadata: UploadMetadata, signal: AbortSignal) {
    return {
      async uploadFromStream(stream: ReadableStream, previews: Thumbnail[]) {
        thumbnailSizes.push(...previews.map((preview) => preview.thumbnail.length));
        const data = await new Response(stream).arrayBuffer();
        return { completion: async () => {
          await beforeCommit?.(signal);
          if (failOn.has(uid)) throw new Error('Upload failed before commit');
          expect(metadata.expectedSize).toBe(data.byteLength);
          const sha1 = createHash('sha1').update(Buffer.from(data)).digest('hex');
          expect(metadata.expectedSha1).toBe(sha1);
          nodes.set(uid, { uid, type: NodeType.File, activeRevision: { claimedDigests: { sha1 } } });
          commits.push(uid);
          return { nodeUid: uid, nodeRevisionUid: String(commits.length) };
        } };
      },
    };
  }
  const ctx = {
    logger: console,
    sdk: {
      createFolder: async (parent: Item, name: string) => {
        const uid = parent.uid + '/' + name;
        if (nodes.has(uid)) throw conflict(uid);
        const node = { uid, type: NodeType.Folder };
        nodes.set(uid, node);
        return node;
      },
      getFileUploader: async (parent: Item, name: string, meta: UploadMetadata, signal: AbortSignal) => {
        const uid = parent.uid + '/' + name;
        if (nodes.has(uid)) throw conflict(uid);
        return writer(uid, meta, signal);
      },
      getFileRevisionUploader: async (uid: string, meta: UploadMetadata, signal: AbortSignal) => writer(uid, meta, signal),
      getNode: async (uid: string) => nodes.get(uid),
    },
  } as unknown as Parameters<typeof upload>[0];
  const progress: number[] = [];
  const run = (sources: string[], fileStrategy = 'skip', includeHidden = false, signal = new AbortController().signal, skipThumbnails = true) =>
    upload(ctx, { sources, fileStrategy, folderStrategy: 'merge', skipThumbnails, includeHidden },
      signal, (bytes) => progress.push(bytes), target);
  return { run, commits, progress, nodes, failOn, thumbnailSizes };
}

test('literal names, zero-byte files, nested hidden policy and empty folders', async () => {
  const tree = path.join(root, 'tree');
  await mkdir(path.join(tree, 'empty'), { recursive: true });
  await writeFile(path.join(tree, '[a] *?.txt'), '');
  await writeFile(path.join(tree, '.private'), 'hidden');
  const d = drive();
  expect(await d.run([tree])).toEqual({ uploaded: 1, skipped: 0 });
  expect(d.nodes.has('/target/tree/empty')).toBe(true);
  expect(d.commits).toEqual(['/target/tree/[a] *?.txt']);
  expect(d.progress).toEqual([0]);
  expect(await d.run([tree], 'skip', true)).toEqual({ uploaded: 1, skipped: 1 });
  expect(d.progress).toEqual([0, 6]);
});

test('add preserves existing content, backup creates a revision only for changed content', async () => {
  const source = path.join(root, 'document');
  const d = drive();
  await writeFile(source, 'first');
  await d.run([source]);
  await writeFile(source, 'replacement');
  expect(await d.run([source])).toEqual({ uploaded: 0, skipped: 1 });
  expect(await d.run([source], 'create-new-revision')).toEqual({ uploaded: 1, skipped: 0 });
  expect(await d.run([source], 'create-new-revision')).toEqual({ uploaded: 0, skipped: 1 });
  expect(d.commits).toEqual(['/target/document', '/target/document']);
  expect(d.progress).toEqual([5, 11]);
});

test('failed commits, cancellation and symlink escapes cannot report a completed file', async () => {
  const source = path.join(root, 'file');
  const d = drive();
  await writeFile(source, 'unchanged');
  d.failOn.add('/target/file');
  await expect(d.run([source])).rejects.toThrow('Upload failed before commit');
  await expect(d.run([source], 'skip', false, AbortSignal.abort())).rejects.toThrow();
  const outside = await mkdtemp(path.join(tmpdir(), 'unmounted-data-'));
  try {
    await writeFile(path.join(outside, 'private'), 'not part of the backup');
    await symlink(outside, path.join(root, 'alias'));
    await expect(d.run([path.join(root, 'alias', 'private')])).rejects.toThrow('escapes LOCAL_ROOT');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
  expect(d.progress).toEqual([]);
});


test('Proton thumbnail helper can decode and resize an image from the bound file descriptor', async () => {
  const source = path.join(root, 'photo.png');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYSsAAAAASUVORK5CYII=';
  await writeFile(source, Buffer.from(png, 'base64'));
  const d = drive();
  await d.run([source], 'skip', false, new AbortController().signal, false);
  expect(d.thumbnailSizes[0]).toBeGreaterThan(0);
});

test('cancelling an active upload aborts its SDK signal and leaves progress uncommitted', async () => {
  const controller = new AbortController();
  const active = Promise.withResolvers<void>();
  const d = drive((signal) => new Promise<void>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    active.resolve();
  }));
  const file = path.join(root, 'active');
  await writeFile(file, 'data');
  const request = d.run([file], 'skip', false, controller.signal);
  await active.promise;
  controller.abort(new Error('Stopped by user'));
  await expect(request).rejects.toThrow('Stopped by user');
  expect(d.progress).toEqual([]);
});
