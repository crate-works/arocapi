import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import type { StorageBackend, StorageLocate } from '../../storage/backend.js';
import { buildTestApp, cleanupTestData, getTestPrisma } from '../integration.setup.js';

/** One stored item: its path below the backend's root, and its bytes */
type StoredItem = { path: string; body: string };

export type StorageContractHarness<Key = string> = {
  /** Call the backend's factory */
  create: (locate?: StorageLocate<Key>) => StorageBackend | Promise<StorageBackend>;
  /** Make the fixed set of items readable, starting from nothing stored */
  prepare: (items: readonly StoredItem[]) => Promise<void>;
  /** The `meta` that points a Record at the item stored at `path` by default */
  meta: (path: string) => Prisma.InputJsonObject;
  /** What a custom `locate` returns for the item stored at `path` */
  key: (path: string) => Key;
};

const crate = JSON.stringify({ '@context': 'https://w3id.org/ro/crate/1.2/context', '@graph': [{ name: 'Ŋaŋa' }] });

const storedItems = [
  { path: 'collection/ro-crate-metadata.json', body: crate },
  { path: 'collection/item/greeting.wav', body: 'RIFF greeting bytes' },
  { path: 'collection/item/notes.bin', body: 'speaker,line\nŋaŋa,hello\n' },
] as const satisfies readonly StoredItem[];

const [crateItem, wavItem, notesItem] = storedItems;

const id = (name: string) => `http://example.com/storage/${name}`;

const licences = {
  metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
  contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
};

type Row = { name: string; meta?: Prisma.InputJsonObject; file?: { filename: string; mediaType: string } };

const createRows = async (rows: Row[]) => {
  const prisma = getTestPrisma();
  await prisma.entity.createMany({
    data: rows.map(({ name, meta, file }) => ({
      id: id(name),
      name,
      description: '',
      entityType: file ? 'http://schema.org/MediaObject' : 'http://pcdm.org/models#Collection',
      ...licences,
      ...(meta && !file && { meta }),
    })),
  });
  await prisma.file.createMany({
    data: rows.flatMap(({ name, meta, file }) =>
      file ? [{ id: id(name), ...file, size: BigInt(1), ...(meta && { meta }) }] : [],
    ),
  });
};

/**
 * The `/entity/:id/metadata` and `/file/:id` cases every stored reference backend must pass
 */
export const describeStorageContract = <Key>(name: string, harness: StorageContractHarness<Key>) => {
  describe(`${name} storage contract`, () => {
    const entityUrl = (name: string) => `/entity/${encodeURIComponent(id(name))}/metadata`;
    const fileUrl = (name: string, query = '') => `/file/${encodeURIComponent(id(name))}${query}`;

    let app: FastifyInstance;

    const getAndHead = async (url: string) => {
      const get = await app.inject({ method: 'GET', url });
      const head = await app.inject({ method: 'HEAD', url });

      return { get, head };
    };

    beforeAll(async () => {
      await cleanupTestData();
      await harness.prepare(storedItems);
      await createRows([
        { name: 'collection', meta: harness.meta(crateItem.path) },
        { name: 'missing-crate', meta: harness.meta('collection/missing.json') },
        { name: 'no-key' },
        { name: 'absolute-crate', meta: harness.meta('/etc/passwd') },
        { name: 'parent-crate', meta: harness.meta('collection/../../outside.json') },
        {
          name: 'greeting.wav',
          meta: harness.meta(wavItem.path),
          file: { filename: 'greeting.wav', mediaType: 'audio/wav' },
        },
        {
          name: 'notes.csv',
          meta: harness.meta(notesItem.path),
          file: { filename: 'notes.csv', mediaType: 'text/csv' },
        },
        {
          name: 'missing.wav',
          meta: harness.meta('collection/item/missing.wav'),
          file: { filename: 'missing.wav', mediaType: 'audio/wav' },
        },
        { name: 'no-key.wav', file: { filename: 'no-key.wav', mediaType: 'audio/wav' } },
        {
          name: 'absolute.wav',
          meta: harness.meta('/etc/passwd'),
          file: { filename: 'absolute.wav', mediaType: 'audio/wav' },
        },
        {
          name: 'parent.wav',
          meta: harness.meta('../outside.wav'),
          file: { filename: 'parent.wav', mediaType: 'audio/wav' },
        },
      ]);
      app = await buildTestApp({ storage: await harness.create() });
    });

    afterAll(async () => {
      await app.close();
      await cleanupTestData();
    });

    describe('Metadata', () => {
      it('serves the stored bytes as JSON-LD, with HEAD headers equal to GET', async () => {
        const { get, head } = await getAndHead(entityUrl('collection'));

        expect(get.statusCode).toBe(200);
        expect(get.body).toBe(crateItem.body);
        expect(get.headers['content-type']).toBe('application/ld+json');
        expect(get.headers['content-length']).toBe(String(Buffer.byteLength(crateItem.body)));
        expect(get.headers.etag).toBeDefined();
        expect(get.headers['last-modified']).toBeDefined();
        expect(head.statusCode).toBe(200);
        expect(head.body).toBe('');
        expect(head.headers).toEqual(get.headers);
      });

      it.each(['missing-crate', 'no-key'])('answers 404 for %s', async (name) => {
        const { get, head } = await getAndHead(entityUrl(name));

        expect(get.statusCode).toBe(404);
        expect(head.statusCode).toBe(404);
      });

      it.each(['absolute-crate', 'parent-crate'])('refuses the unsafe key of %s with 500', async (name) => {
        const { get, head } = await getAndHead(entityUrl(name));

        expect(get.statusCode).toBe(500);
        expect(get.body).not.toContain('passwd');
        expect(head.statusCode).toBe(500);
      });
    });

    describe('Content', () => {
      it('serves the stored bytes, with HEAD headers equal to GET', async () => {
        const { get, head } = await getAndHead(fileUrl('greeting.wav'));

        expect(get.statusCode).toBe(200);
        expect(get.body).toBe(wavItem.body);
        expect(get.headers['content-type']).toBe('audio/wav');
        expect(get.headers['content-length']).toBe(String(Buffer.byteLength(wavItem.body)));
        expect(get.headers['content-disposition']).toBe('inline; filename=greeting.wav');
        expect(get.headers.etag).toBeDefined();
        expect(get.headers['last-modified']).toBeDefined();
        expect(head.statusCode).toBe(200);
        expect(head.body).toBe('');
        expect(head.headers).toEqual(get.headers);
      });

      it('takes Content-Type from File.mediaType, not the stored name', async () => {
        const { get } = await getAndHead(fileUrl('notes.csv'));

        expect(get.body).toBe(notesItem.body);
        expect(get.headers['content-type']).toBe('text/csv');
      });

      it('honours ?disposition and ?filename', async () => {
        const { get, head } = await getAndHead(fileUrl('greeting.wav', '?disposition=attachment&filename=hello.wav'));

        expect(get.headers['content-disposition']).toBe('attachment; filename=hello.wav');
        expect(head.headers['content-disposition']).toBe('attachment; filename=hello.wav');
      });

      it.each(['missing.wav', 'no-key.wav'])('answers 404 for %s', async (name) => {
        const { get, head } = await getAndHead(fileUrl(name));

        expect(get.statusCode).toBe(404);
        expect(head.statusCode).toBe(404);
      });

      it.each(['absolute.wav', 'parent.wav'])('refuses the unsafe key of %s with 500', async (name) => {
        const { get, head } = await getAndHead(fileUrl(name));

        expect(get.statusCode).toBe(500);
        expect(head.statusCode).toBe(500);
      });
    });

    describe('with a custom locate', () => {
      let located: FastifyInstance;

      const paths: Record<string, string | null> = {
        [id('no-key')]: crateItem.path,
        [id('no-key.wav')]: wavItem.path,
        [id('collection')]: null,
        [id('greeting.wav')]: null,
        [id('absolute-crate')]: '/etc/passwd',
        [id('absolute.wav')]: 'collection/../../outside.wav',
      };
      const locate = (entityId: string) => {
        const path = paths[entityId] ?? null;

        return path === null ? null : harness.key(path);
      };

      beforeAll(async () => {
        located = await buildTestApp({
          storage: await harness.create({
            metadata: (entity) => locate(entity.id),
            content: async (file) => locate(file.id),
          }),
        });
      });

      afterAll(async () => {
        await located.close();
      });

      it('serves what locate names, ignoring meta', async () => {
        const metadata = await located.inject({ method: 'GET', url: entityUrl('no-key') });
        const content = await located.inject({ method: 'GET', url: fileUrl('no-key.wav') });

        expect(metadata.statusCode).toBe(200);
        expect(metadata.body).toBe(crateItem.body);
        expect(content.statusCode).toBe(200);
        expect(content.body).toBe(wavItem.body);
      });

      it('answers 404 when locate returns null', async () => {
        const metadata = await located.inject({ method: 'GET', url: entityUrl('collection') });
        const content = await located.inject({ method: 'GET', url: fileUrl('greeting.wav') });

        expect(metadata.statusCode).toBe(404);
        expect(content.statusCode).toBe(404);
      });

      it('refuses an unsafe key from locate with 500', async () => {
        const metadata = await located.inject({ method: 'GET', url: entityUrl('absolute-crate') });
        const content = await located.inject({ method: 'GET', url: fileUrl('absolute.wav') });

        expect(metadata.statusCode).toBe(500);
        expect(content.statusCode).toBe(500);
      });
    });
  });
};
