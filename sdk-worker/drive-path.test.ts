import { expect, test } from 'bun:test';
import { resolve } from './drive-path';

type Ctx = Parameters<typeof resolve>[0];
function context(cached: string, fresh: string, available: boolean) {
  let invalidated = false;
  const parent = { uid: 'r' };
  const candidate = { uid: 'c', parentUid: 'r', name: { ok: true, value: cached } };
  return {
    paths: { getNode: async () => parent },
    caches: {
      entitiesCache: {
        removeEntities: async (keys: string[]) => {
          invalidated = keys.includes('node-c');
        },
      },
    },
    sdk: {
      async *iterateFolderChildren() {
        yield candidate;
      },
      async getNode() {
        return { ...candidate, name: { ok: true, value: invalidated ? fresh : cached } };
      },
      async getAvailableName(_: unknown, name: string) {
        return available ? name : name + ' (1)';
      },
    },
  } as unknown as Ctx;
}

test('a cached file renamed before another file took its name cannot be selected', async () => {
  await expect(resolve(context('a', 'b', false), '/my-files/a', true)).rejects.toThrow('Cannot verify');
});
test('server-confirmed absence and network/uncertain identity are distinct', async () => {
  await expect(resolve(context('b', 'b', true), '/my-files/a', true)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  const ctx = context('b', 'b', false);
  ctx.sdk.getAvailableName = () => Promise.reject(new Error('offline'));
  await expect(resolve(ctx, '/my-files/a', true)).rejects.toThrow('offline');
});
test('UID-shaped file names are traversed literally from My files', async () => {
  const name = 'a'.repeat(22) + '~' + 'b'.repeat(22);
  expect((await resolve(context(name, name, false), '/my-files/' + name, true)).uid).toBe('c');
});
