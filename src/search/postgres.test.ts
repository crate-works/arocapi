import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { isolatedPrisma } from '../test/helpers/postgresSchema.js';
import { describeSearchBackendWrites } from '../test/helpers/searchBackendWrite.js';
import type { FieldDeclarations } from './fields.js';
import { PostgresBackend } from './postgres.js';

let prisma: PrismaClient;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ prisma, drop } = await isolatedPrisma('postgres_backend_test'));
});

afterAll(() => drop());

const entity = (id: string) => ({
  id,
  name: id,
  description: '',
  entityType: 'http://schema.org/CreativeWork',
  metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
  contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
});

const reset = async (ids: string[]) => {
  await prisma.entity.deleteMany({});
  await prisma.entity.createMany({ data: ids.map(entity) });
};

type Row = { values: Record<string, unknown>; lat: number | null; lng: number | null; geohash: string | null };

const readRow = async (id: string) => {
  const [row] = await prisma.$queryRaw<Row[]>`
    SELECT "values", point[1] AS lat, point[0] AS lng, geohash FROM entity_search WHERE id = ${id}
  `;

  return row;
};

describeSearchBackendWrites('PostgresBackend', {
  create: (fields) => PostgresBackend({ prisma, fields }),
  prepare: () => reset(['http://example.com/1', 'http://example.com/2', 'http://example.com/bad']),
  read: async (id) => {
    const row = await readRow(id);
    if (!row) {
      return undefined;
    }
    const { values, lat, lng } = row;

    return { id, ...values, ...(lat !== null && { location: { lat, lng } }) };
  },
});

describe('PostgresBackend', () => {
  const fields = {
    name: { type: 'text', weight: 4 },
    inLanguage: { type: 'keyword', facet: true },
  } satisfies FieldDeclarations;

  const read = async (id: string) => (await readRow(id))?.values;

  beforeEach(() => reset(['http://example.com/1']));

  describe('index with a transaction', () => {
    it('commits the search document with the entity', async () => {
      const backend = PostgresBackend({ prisma, fields });

      await prisma.$transaction(async (tx) => {
        await tx.entity.create({ data: entity('http://example.com/new') });
        await backend.index([{ id: 'http://example.com/new', name: 'New' }], { tx });
      });

      expect(await read('http://example.com/new')).toEqual({ name: 'New' });
    });

    it('rolls back the search document with the entity', async () => {
      const backend = PostgresBackend({ prisma, fields });

      await expect(
        prisma.$transaction(async (tx) => {
          await tx.entity.create({ data: entity('http://example.com/new') });
          await backend.index([{ id: 'http://example.com/new', name: 'New' }], { tx });
          throw new Error('Deposit failed');
        }),
      ).rejects.toThrow('Deposit failed');

      expect(await prisma.entity.findUnique({ where: { id: 'http://example.com/new' } })).toBeNull();
      expect(await read('http://example.com/new')).toBeUndefined();
    });

    it('leaves the transaction usable after naming missing entities', async () => {
      const backend = PostgresBackend({ prisma, fields });

      await prisma.$transaction(async (tx) => {
        await expect(backend.index([{ id: 'http://example.com/missing' }], { tx })).rejects.toThrow(
          '"http://example.com/missing"',
        );
        await backend.index([{ id: 'http://example.com/1', name: 'One' }], { tx });
      });

      expect(await read('http://example.com/1')).toEqual({ name: 'One' });
    });
  });

  it('throws naming the missing entities, and stores nothing from the batch', async () => {
    const backend = PostgresBackend({ prisma, fields });

    const indexing = backend.index([
      { id: 'http://example.com/1', name: 'One' },
      { id: 'http://example.com/missing-a' },
      { id: 'http://example.com/missing-b' },
    ]);

    await expect(indexing).rejects.toThrow(
      'Search documents reference entities that don\'t exist: "http://example.com/missing-a", "http://example.com/missing-b"',
    );
    expect(await read('http://example.com/1')).toBeUndefined();
  });

  it('removes the search document when its entity is deleted', async () => {
    const backend = PostgresBackend({ prisma, fields });
    await backend.index([{ id: 'http://example.com/1', name: 'One' }]);

    await prisma.entity.delete({ where: { id: 'http://example.com/1' } });

    expect(await read('http://example.com/1')).toBeUndefined();
  });

  it('keeps the last of a repeated id in a batch', async () => {
    const backend = PostgresBackend({ prisma, fields });

    await backend.index([
      { id: 'http://example.com/1', name: 'First' },
      { id: 'http://example.com/1', name: 'Last' },
    ]);

    expect(await read('http://example.com/1')).toEqual({ name: 'Last' });
  });

  it('stores the full-length geohash of the point', async () => {
    const backend = PostgresBackend({ prisma, fields: { location: { type: 'geo' } } });

    await backend.index([{ id: 'http://example.com/1', location: { lat: 57.64911, lng: 10.40744 } }]);

    expect((await readRow('http://example.com/1'))?.geohash).toMatch(/^u4pruydqqvj[0-9b-hjkmnp-z]$/);
  });

  it('publishes capabilities from the field declarations', () => {
    expect(PostgresBackend({ prisma, fields }).capabilities).toEqual({
      filters: { inLanguage: { type: 'string' } },
      facets: { inLanguage: {} },
      sorts: {},
      searchTypes: { basic: {} },
      geo: { supported: false },
    });
  });
});
