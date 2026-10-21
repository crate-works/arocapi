import { setTimeout as sleep } from 'node:timers/promises';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import type { Entity, File } from '../../generated/prisma/client.js';
import { prisma } from '../../test/helpers/fastify.js';
import { putTestObjects, testS3Client } from '../../test/helpers/s3.js';
import { buildStorageApp } from '../../test/helpers/storageApp.js';
import type { ContentContext, RedirectDelivery } from '../backend.js';
import { S3Storage } from './s3.js';

const bucket = 's3-storage-test';

const entity: Entity = {
  id: 'http://example.com/item.wav',
  name: 'item.wav',
  description: '',
  entityType: 'http://schema.org/MediaObject',
  memberOf: null,
  rootCollection: null,
  metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
  contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
  meta: { storageKey: 'item/ro-crate-metadata.json' },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const file: File = {
  id: entity.id,
  filename: 'item.wav',
  mediaType: 'audio/wav',
  size: BigInt(1),
  meta: { storageKey: 'item/item.wav' },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const context = { contentDisposition: 'attachment; filename="field recording.wav"' } as ContentContext;

const presign = async (storage: ReturnType<typeof S3Storage>) =>
  ((await storage.content(file, entity, context)) as RedirectDelivery).url;

describe('S3Storage', () => {
  const client = testS3Client();

  beforeAll(async () => {
    await putTestObjects(client, bucket, [
      { path: 'item/ro-crate-metadata.json', body: '{}' },
      { path: 'item/item.wav', body: 'RIFF item bytes' },
    ]);
  });

  afterAll(() => {
    client.destroy();
  });

  describe('redirect', () => {
    it('presigns for 300 seconds by default', async () => {
      const url = new URL(await presign(S3Storage({ client, bucket })));

      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    });

    it('presigns for expiresIn seconds, after which the URL is refused', async () => {
      const url = await presign(S3Storage({ client, bucket, expiresIn: 1 }));

      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('1');
      await sleep(2500);
      expect((await fetch(url)).status).toBe(403);
    });

    it('makes the bucket answer with File.mediaType and the request disposition', async () => {
      const response = await fetch(await presign(S3Storage({ client, bucket })));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('RIFF item bytes');
      expect(response.headers.get('content-type')).toBe('audio/wav');
      expect(response.headers.get('content-disposition')).toBe('attachment; filename="field recording.wav"');
    });
  });

  describe('stream', () => {
    beforeEach(() => {
      mockReset(prisma);
    });

    it('answers 500 when the object changes between its headers and its bytes', async () => {
      const storage = S3Storage({ client, bucket, delivery: 'stream' });
      const { app, errors } = await buildStorageApp({
        metadata: storage.metadata,
        content: async (...args) => {
          const delivery = await storage.content(...args);
          await client.send(new PutObjectCommand({ Bucket: bucket, Key: 'item/changing.wav', Body: 'second version' }));

          return delivery;
        },
      });
      await putTestObjects(client, bucket, [{ path: 'item/changing.wav', body: 'first version' }]);
      prisma.file.findFirst.mockResolvedValue({ ...file, meta: { storageKey: 'item/changing.wav' }, entity } as File);

      const response = await app.inject({ method: 'GET', url: `/file/${encodeURIComponent(file.id)}` });

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('version');
      expect(errors.map(({ err }) => err?.message)).toEqual([expect.stringContaining('ondition')]);
      await app.close();
    });

    it('finds nothing for a missing object or bucket', async () => {
      const storage = S3Storage({ client, bucket, delivery: 'stream' });
      const elsewhere = S3Storage({ client, bucket: 'no-such-bucket', delivery: 'stream' });
      const missing = { storageKey: 'item/missing.wav' };

      await expect(storage.metadata({ ...entity, meta: missing }, context)).resolves.toBeNull();
      await expect(storage.content({ ...file, meta: missing }, entity, context)).resolves.toBeNull();
      await expect(elsewhere.content(file, entity, context)).resolves.toBeNull();
    });

    it('throws when the bucket refuses the request', async () => {
      const refused = testS3Client('wrong');

      await expect(S3Storage({ client: refused, bucket }).metadata(entity, context)).rejects.toThrow();
      refused.destroy();
    });
  });

  it.each([
    ['absolute', '/item/item.wav'],
    ['parent', 'item/../../item.wav'],
  ])('throws on a %s key before any request or presign', async (_kind, storageKey) => {
    const send = vi.spyOn(client, 'send');
    const meta = { storageKey };

    for (const storage of [S3Storage({ client, bucket }), S3Storage({ client, bucket, delivery: 'stream' })]) {
      await expect(storage.metadata({ ...entity, meta }, context)).rejects.toThrow('unsafe storage key');
      await expect(storage.content({ ...file, meta }, entity, context)).rejects.toThrow('unsafe storage key');
    }
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });

  it.each([42, ['item.wav'], { key: 'item.wav' }])(
    'throws naming the entity and key when storageKey is %j',
    async (storageKey) => {
      const storage = S3Storage({ client, bucket });
      const meta = { storageKey };

      await expect(storage.metadata({ ...entity, meta }, context)).rejects.toThrow(
        'http://example.com/item.wav has a meta.storageKey that is not a string',
      );
      await expect(storage.content({ ...file, meta }, entity, context)).rejects.toThrow(
        'http://example.com/item.wav has a meta.storageKey that is not a string',
      );
    },
  );
});
