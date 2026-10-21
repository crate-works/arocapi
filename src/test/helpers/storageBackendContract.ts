import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  ContentSource,
  MaybePromise,
  MetadataSource,
  StorageBackend,
  StorageLocate,
} from '../../storage/backend.js';
import { buildTestApp, cleanupTestData, getTestPrisma } from '../integration.setup.js';
import { getAndHead } from './getAndHead.js';
import { storedItems } from './storedItems.js';

type Prepared = {
  /** Make the fixed set of items readable, starting from nothing stored */
  prepare: (items: typeof storedItems) => Promise<void>;
  /** The `meta` that points a Record at the item stored at `path` by default */
  meta: (path: string) => Prisma.InputJsonObject;
};

/** What a custom `locate` returns for the item stored at `path`; the path itself unless given */
type Keyed<Key> = string extends Key ? { key?: (path: string) => Key } : { key: (path: string) => Key };

export type MetadataContractHarness<Key = string> = Prepared & {
  /** The app's storage, of which only the Metadata half is exercised */
  storage: () => MaybePromise<StorageBackend>;
  /** For Metadata read from a Storage key: served byte for byte with Last-Modified, unsafe keys refused, and `locate` honoured */
  stored?: Keyed<Key> & { locate: (locate: StorageLocate<Key>) => MaybePromise<StorageBackend> };
};

export type ContentContractHarness<Key = string> = Prepared &
  Keyed<Key> & { content: (locate?: StorageLocate<Key>) => MaybePromise<ContentSource> };

export type StorageContractHarness<Key = string> = Prepared &
  Keyed<Key> & { create: (locate?: StorageLocate<Key>) => MaybePromise<StorageBackend> };

const [crateItem, wavItem, notesItem] = storedItems;

const keyOf = <Key>(keyed: { key?: (path: string) => Key }) => keyed.key ?? ((path: string) => path as Key);

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

/** What a client relies on from the server a redirect sends it to; the rest varies per response */
const followedHeaders = ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified'];

/**
 * What the client ends up with: arocapi's response, or the response of the server it redirects to
 */
const serve = async (instance: FastifyInstance, method: 'GET' | 'HEAD', url: string) => {
  const reply = await instance.inject({ method, url });
  if (reply.statusCode !== 302) {
    return { statusCode: reply.statusCode, body: reply.body, headers: reply.headers };
  }

  // A presigned URL is signed for GET only, so HEAD's redirect is followed with GET and its body dropped
  const response = await fetch(String(reply.headers.location));
  const body = await response.text();
  const headers = followedHeaders.flatMap((header) => {
    const value = response.headers.get(header);

    return value === null ? [] : [[header, value]];
  });

  return { statusCode: response.status, body: method === 'HEAD' ? '' : body, headers: Object.fromEntries(headers) };
};

const entityUrl = (name: string) => `/entity/${encodeURIComponent(id(name))}/metadata`;
const fileUrl = (name: string, query = '') => `/file/${encodeURIComponent(id(name))}${query}`;

const noMetadata: MetadataSource = () => null;

/**
 * Store the items and create `rows` before the suite, and remove both after it
 */
const useRows = (harness: Prepared, rows: () => Row[]) => {
  beforeAll(async () => {
    await cleanupTestData();
    await harness.prepare(storedItems);
    await createRows(rows());
  });

  afterAll(async () => {
    await cleanupTestData();
  });
};

/**
 * An app serving `storage`, built before the suite and closed after it
 */
const useApp = (storage: () => MaybePromise<StorageBackend>) => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp({ storage: await storage() });
  });

  afterAll(async () => {
    await app.close();
  });

  return (url: string) => getAndHead((method) => serve(app, method, url));
};

/**
 * The `/entity/:id/metadata` cases every reference Metadata half must pass
 */
export const describeMetadataContract = <Key = string>(name: string, harness: MetadataContractHarness<Key>) => {
  const { stored } = harness;

  describe(`${name} Metadata contract`, () => {
    useRows(harness, () => [
      { name: 'collection', meta: harness.meta(crateItem.path) },
      { name: 'missing-crate', meta: harness.meta('collection/missing.json') },
      { name: 'no-key' },
      { name: 'absolute-crate', meta: harness.meta('/etc/passwd') },
      { name: 'parent-crate', meta: harness.meta('collection/../../outside.json') },
    ]);
    const request = useApp(harness.storage);

    it('serves the stored Metadata as JSON-LD, with HEAD headers equal to GET', async () => {
      const { get, head } = await request(entityUrl('collection'));

      expect(get.statusCode).toBe(200);
      if (stored) {
        expect(get.body).toBe(crateItem.body);
        expect(get.headers['last-modified']).toBeDefined();
      } else {
        expect(JSON.parse(get.body)).toEqual(JSON.parse(crateItem.body));
      }
      expect(get.headers['content-type']).toBe('application/ld+json');
      expect(get.headers['content-length']).toBe(String(Buffer.byteLength(get.body)));
      expect(get.headers.etag).toBeDefined();
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers).toEqual(get.headers);
    });

    it.each(['missing-crate', 'no-key'])('answers 404 for %s', async (name) => {
      const { get, head } = await request(entityUrl(name));

      expect(get.statusCode).toBe(404);
      expect(head.statusCode).toBe(404);
    });

    if (stored) {
      it.each(['absolute-crate', 'parent-crate'])('refuses the unsafe key of %s with 500', async (name) => {
        const { get, head } = await request(entityUrl(name));

        expect(get.statusCode).toBe(500);
        expect(get.body).not.toContain('passwd');
        expect(head.statusCode).toBe(500);
      });

      describe('with a custom locate', () => {
        const key = keyOf(stored);
        const paths: Record<string, string | null> = {
          [id('no-key')]: crateItem.path,
          [id('collection')]: null,
          [id('absolute-crate')]: '/etc/passwd',
        };
        const located = useApp(() =>
          stored.locate({
            metadata: (entity) => {
              const path = paths[entity.id] ?? null;

              return path === null ? null : key(path);
            },
          }),
        );

        it('serves what locate names, ignoring meta', async () => {
          const { get } = await located(entityUrl('no-key'));

          expect(get.statusCode).toBe(200);
          expect(get.body).toBe(crateItem.body);
        });

        it('answers 404 when locate returns null', async () => {
          const { get } = await located(entityUrl('collection'));

          expect(get.statusCode).toBe(404);
        });

        it('refuses an unsafe key from locate with 500', async () => {
          const { get } = await located(entityUrl('absolute-crate'));

          expect(get.statusCode).toBe(500);
        });
      });
    }
  });
};

/**
 * The `/file/:id` cases every reference Content half must pass
 */
const describeContentContract = <Key = string>(name: string, harness: ContentContractHarness<Key>) => {
  const file = (name: string, mediaType: string, path?: string): Row => ({
    name,
    file: { filename: name, mediaType },
    ...(path !== undefined && { meta: harness.meta(path) }),
  });

  describe(`${name} Content contract`, () => {
    useRows(harness, () => [
      file('greeting.wav', 'audio/wav', wavItem.path),
      file('notes.csv', 'text/csv', notesItem.path),
      file('missing.wav', 'audio/wav', 'collection/item/missing.wav'),
      file('no-key.wav', 'audio/wav'),
      file('absolute.wav', 'audio/wav', '/etc/passwd'),
      file('parent.wav', 'audio/wav', '../outside.wav'),
    ]);
    const request = useApp(async () => ({ metadata: noMetadata, content: await harness.content() }));

    it('serves the stored bytes, with HEAD headers equal to GET', async () => {
      const { get, head } = await request(fileUrl('greeting.wav'));

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
      const { get } = await request(fileUrl('notes.csv'));

      expect(get.body).toBe(notesItem.body);
      expect(get.headers['content-type']).toBe('text/csv');
    });

    it('honours ?disposition and ?filename', async () => {
      const { get, head } = await request(fileUrl('greeting.wav', '?disposition=attachment&filename=hello.wav'));

      expect(get.headers['content-disposition']).toBe('attachment; filename=hello.wav');
      expect(head.headers['content-disposition']).toBe('attachment; filename=hello.wav');
    });

    it.each(['missing.wav', 'no-key.wav'])('answers 404 for %s', async (name) => {
      const { get, head } = await request(fileUrl(name));

      expect(get.statusCode).toBe(404);
      expect(head.statusCode).toBe(404);
    });

    it.each(['absolute.wav', 'parent.wav'])('refuses the unsafe key of %s with 500', async (name) => {
      const { get, head } = await request(fileUrl(name));

      expect(get.statusCode).toBe(500);
      expect(head.statusCode).toBe(500);
    });

    describe('with a custom locate', () => {
      const key = keyOf(harness);
      const paths: Record<string, string | null> = {
        [id('no-key.wav')]: wavItem.path,
        [id('greeting.wav')]: null,
        [id('absolute.wav')]: 'collection/../../outside.wav',
      };
      const located = useApp(async () => ({
        metadata: noMetadata,
        content: await harness.content({
          content: async (file) => {
            const path = paths[file.id] ?? null;

            return path === null ? null : key(path);
          },
        }),
      }));

      it('serves what locate names, ignoring meta', async () => {
        const { get } = await located(fileUrl('no-key.wav'));

        expect(get.statusCode).toBe(200);
        expect(get.body).toBe(wavItem.body);
      });

      it('answers 404 when locate returns null', async () => {
        const { get } = await located(fileUrl('greeting.wav'));

        expect(get.statusCode).toBe(404);
      });

      it('refuses an unsafe key from locate with 500', async () => {
        const { get } = await located(fileUrl('absolute.wav'));

        expect(get.statusCode).toBe(500);
      });
    });
  });
};

/**
 * Both contracts for a stored reference backend, whose halves read Storage keys
 */
export const describeStorageContract = <Key = string>(name: string, harness: StorageContractHarness<Key>) => {
  const { create, ...prepared } = harness;
  const keyed = { key: keyOf<Key>(harness) } as Keyed<Key>;

  describeMetadataContract<Key>(name, {
    ...prepared,
    storage: () => create(),
    stored: { ...keyed, locate: create },
  });
  describeContentContract<Key>(name, {
    ...prepared,
    ...keyed,
    content: async (locate) => (await create(locate)).content,
  });
};
