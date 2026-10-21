import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entityRow, fileRow } from '../../test/helpers/rows.js';
import type { ContentContext } from '../backend.js';
import { DirectoryStorage } from './directory.js';

const entity = entityRow();

const file = fileRow({ id: entity.id });

const context = {} as ContentContext;

describe('DirectoryStorage', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'arocapi-directory-'));
    await mkdir(join(root, 'item'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true });
  });

  it.each([42, { path: 'item.wav' }, ['item.wav'], true, null])(
    'throws naming the entity and key when storagePath is %j',
    async (storagePath) => {
      const storage = DirectoryStorage({ root });

      await expect(storage.metadata({ ...entity, meta: { storagePath } }, context)).rejects.toThrow(
        'http://example.com/item has a meta.storagePath that is not a string',
      );
      await expect(storage.content({ ...file, meta: { storagePath } }, entity, context)).rejects.toThrow(
        'http://example.com/item has a meta.storagePath that is not a string',
      );
    },
  );

  it.each([null, ['item.wav'], 'item.wav', {}])('finds nothing when meta is %j', async (meta) => {
    const storage = DirectoryStorage({ root });

    await expect(storage.metadata({ ...entity, meta }, context)).resolves.toBeNull();
    await expect(storage.content({ ...file, meta }, entity, context)).resolves.toBeNull();
  });

  it('finds nothing at a directory', async () => {
    const storage = DirectoryStorage({ root });

    await expect(storage.content({ ...file, meta: { storagePath: 'item' } }, entity, context)).resolves.toBeNull();
  });

  it('throws when storage cannot be read', async () => {
    const storage = DirectoryStorage({ root });

    await expect(storage.content({ ...file, meta: { storagePath: 'item\0.wav' } }, entity, context)).rejects.toThrow();
  });
});
