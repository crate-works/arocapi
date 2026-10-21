import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import type { Entity, File } from '../../generated/prisma/client.js';
import { prisma } from '../../test/helpers/fastify.js';
import { entityRow, fileRow } from '../../test/helpers/rows.js';
import { buildStorageApp } from '../../test/helpers/storageApp.js';
import type { ContentContext, StorageBackend } from '../backend.js';
import { OcflStorage } from './ocfl.js';

const fixtures = join(import.meta.dirname, '../../test/fixtures/ocfl');
const pathDirect = join(fixtures, 'path-direct');
const customLayout = join(fixtures, 'custom-layout');

const contract = 'https://example.com/storage/contract';
const itemCrate = JSON.stringify({ '@context': 'https://w3id.org/ro/crate/1.2/context', '@graph': [{ name: 'Item' }] });

const entity = entityRow();

const file = fileRow({ id: entity.id });

const context = {} as ContentContext;

const apps: FastifyInstance[] = [];

/**
 * One app serving `storage`, answering for the entity or file with the `meta` given per request
 */
const serving = async (storage: StorageBackend) => {
  const { app } = await buildStorageApp(storage);
  apps.push(app);

  return {
    metadata: (meta: Entity['meta']) => {
      prisma.entity.findFirst.mockResolvedValue({ ...entity, meta });

      return app.inject({ method: 'GET', url: `/entity/${encodeURIComponent(entity.id)}/metadata` });
    },
    content: (meta: File['meta']) => {
      // findFirst's mock is typed without the include
      prisma.file.findFirst.mockResolvedValue({ ...file, meta, entity } as File);

      return app.inject({ method: 'GET', url: `/file/${encodeURIComponent(file.id)}` });
    },
  };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  mockReset(prisma);
});

describe('OcflStorage', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'arocapi-ocfl-'));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true });
  });

  const storageRoot = async (name: string, files: Record<string, string>) => {
    const root = join(scratch, name);
    await mkdir(root);
    await writeFile(join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), body);
    }

    return root;
  };

  describe('at startup', () => {
    it("serves LDaCA's 000N-path-direct-storage-layout", async () => {
      const served = await serving(await OcflStorage({ root: pathDirect }));

      const response = await served.metadata({ ocflObject: 'https://example.com/storage/item' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(itemCrate);
    });

    it.each([
      ['0002-flat-direct-storage-layout', 'flat-direct', ['object-01', '..hor_rib:lé-$id']],
      [
        '0003-hash-and-id-n-tuple-storage-layout',
        'hash-and-id-n-tuple',
        ['object-01', '..Hor/rib:lè-$id', "info:fedora/Object~01!'()*", 'abcdefghij'.repeat(11)],
      ],
      [
        '0004-hashed-n-tuple-storage-layout',
        'hashed-n-tuple',
        ['object-01', '..hor/rib:le-$id', '/rooted/id', 'up/../../id'],
      ],
    ])('serves %s with its extension config', async (_, dir, ids) => {
      const served = await serving(await OcflStorage({ root: join(fixtures, dir) }));

      for (const ocflObject of ids) {
        const metadata = await served.metadata({ ocflObject, ocflPath: 'collection/ro-crate-metadata.json' });
        const content = await served.content({ ocflObject, ocflPath: 'collection/item/greeting.wav' });

        expect(metadata.statusCode, ocflObject).toBe(200);
        expect(content.body, ocflObject).toBe('RIFF greeting bytes');
      }
    });

    it("uses a hashed layout's defaults without extension config", async () => {
      const root = await storageRoot('hashed-defaults', {
        'ocfl_layout.json': JSON.stringify({ extension: '0004-hashed-n-tuple-storage-layout' }),
      });
      await cp(
        join(fixtures, 'hashed-n-tuple/ff/75/53/44/92/48/5e/ab/b3/9f/86/35/67/28/88/4e'),
        join(root, '3c0/ff4/240/3c0ff4240c1e116dba14c7627f2319b58aa3d77606d0d90dfc6161608ac987d4'),
        { recursive: true },
      );
      const served = await serving(await OcflStorage({ root }));

      const response = await served.content({ ocflObject: 'object-01', ocflPath: 'collection/item/greeting.wav' });

      expect(response.body).toBe('RIFF greeting bytes');
    });

    it("honours the layout's extension config", async () => {
      const root = await storageRoot('omit-scheme', {
        'ocfl_layout.json': JSON.stringify({ extension: '000N-path-direct-storage-layout' }),
        'extensions/000N-path-direct-storage-layout/config.json': JSON.stringify({ omitScheme: true }),
      });
      await cp(
        join(pathDirect, 'https_example.com/storage/item/__object__'),
        join(root, 'example.com/storage/item/__object__'),
        { recursive: true },
      );
      const served = await serving(await OcflStorage({ root }));

      const response = await served.metadata({ ocflObject: 'https://example.com/storage/item' });

      expect(response.body).toBe(itemCrate);
    });

    it('throws on a layout it does not implement', async () => {
      await expect(OcflStorage({ root: customLayout })).rejects.toThrow(
        "uses the storage layout example-custom-layout, which OcflStorage doesn't implement; pass objectRoot",
      );
    });

    it('serves a layout it does not implement through objectRoot', async () => {
      const served = await serving(
        await OcflStorage({ root: customLayout, objectRoot: (id) => `objects/${id.split('/').at(-1)}` }),
      );

      const response = await served.metadata({ ocflObject: 'https://example.com/storage/custom' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(itemCrate);
    });

    it('throws without ocfl_layout.json unless objectRoot is given', async () => {
      const root = await storageRoot('no-layout', {});

      await expect(OcflStorage({ root })).rejects.toThrow('has no ocfl_layout.json naming its storage layout');
      await expect(OcflStorage({ root, objectRoot: (id) => id })).resolves.toBeDefined();
    });

    it('throws when ocfl_layout.json cannot be read', async () => {
      const root = await storageRoot('unreadable-layout', { 'ocfl_layout.json/inside': '' });

      await expect(OcflStorage({ root })).rejects.toThrow('EISDIR');
    });

    it('throws on a directory that is not a storage root', async () => {
      await expect(OcflStorage({ root: join(pathDirect, 'https_example.com') })).rejects.toThrow(
        'is not an OCFL storage root',
      );
      await expect(OcflStorage({ root: join(scratch, 'nothing-here') })).rejects.toThrow('is not an OCFL storage root');
    });
  });

  describe('objectRoot', () => {
    it('refuses an object root outside the storage root with 500', async () => {
      const served = await serving(await OcflStorage({ root: customLayout, objectRoot: async () => '../path-direct' }));

      const response = await served.metadata({ ocflObject: 'https://example.com/storage/item' });

      expect(response.statusCode).toBe(500);
    });

    it('refuses a path-direct object id that maps outside the storage root with 500', async () => {
      const served = await serving(await OcflStorage({ root: pathDirect }));

      const response = await served.metadata({ ocflObject: '../../outside' });

      expect(response.statusCode).toBe(500);
      await expect(
        (await OcflStorage({ root: pathDirect })).metadata(
          { ...entity, meta: { ocflObject: '../../outside' } },
          context,
        ),
      ).rejects.toThrow('is outside the storage root');
    });
  });

  describe('versions', () => {
    it('serves the head version, ignoring older versions and the mutable HEAD', async () => {
      const served = await serving(await OcflStorage({ root: pathDirect }));
      const body = 'RIFF greeting bytes';

      const response = await served.content({ ocflObject: contract, ocflPath: 'collection/item/greeting.wav' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(body);
      expect(response.headers.etag).toBe(`"${createHash('sha512').update(body).digest('hex')}"`);
    });

    it('answers 404 for a path only in an older version', async () => {
      const served = await serving(await OcflStorage({ root: pathDirect }));

      const response = await served.content({ ocflObject: contract, ocflPath: 'collection/item/removed.wav' });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('damaged inventories', () => {
    it.each(['bad-sidecar', 'unparseable', 'escaping-manifest', 'directory-manifest'])(
      'answers 500 for %s',
      async (name) => {
        const served = await serving(await OcflStorage({ root: pathDirect }));

        const response = await served.content({
          ocflObject: `https://example.com/storage/${name}`,
          ocflPath: 'collection/item/greeting.wav',
        });

        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('RIFF');
      },
    );

    it('refuses a manifest path naming a directory before delivering it, for HEAD as well as GET', async () => {
      const storage = await OcflStorage({ root: pathDirect });
      const meta = {
        ocflObject: 'https://example.com/storage/directory-manifest',
        ocflPath: 'collection/item/greeting.wav',
      };

      await expect(storage.content({ ...file, meta }, entity, context)).rejects.toThrow(
        'has a manifest path that is not a file',
      );
    });
  });

  describe('locations', () => {
    it('finds nothing for a missing object or logical path', async () => {
      const storage = await OcflStorage({ root: pathDirect });

      await expect(
        storage.content(
          { ...file, meta: { ocflObject: 'https://example.com/storage/none', ocflPath: 'a.wav' } },
          entity,
          context,
        ),
      ).resolves.toBeNull();
      await expect(
        storage.content({ ...file, meta: { ocflObject: contract, ocflPath: 'collection/none.wav' } }, entity, context),
      ).resolves.toBeNull();
    });

    it('finds no Content without an ocflPath', async () => {
      const storage = await OcflStorage({ root: pathDirect });

      await expect(storage.content({ ...file, meta: { ocflObject: contract } }, entity, context)).resolves.toBeNull();
    });

    it.each([
      ['ocflObject', { ocflObject: 42, ocflPath: 'a.wav' }],
      ['ocflPath', { ocflObject: contract, ocflPath: ['a.wav'] }],
      ['ocflObject', { ocflObject: null, ocflPath: 'a.wav' }],
      ['ocflPath', { ocflObject: contract, ocflPath: null }],
    ])('throws naming the entity and key when %s is not a string', async (key, meta) => {
      const storage = await OcflStorage({ root: pathDirect });
      const message = `http://example.com/item has a meta.${key} that is not a string`;

      await expect(storage.metadata({ ...entity, meta }, context)).rejects.toThrow(message);
      await expect(storage.content({ ...file, meta }, entity, context)).rejects.toThrow(message);
    });
  });
});
