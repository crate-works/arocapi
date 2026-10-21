import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { Options } from '../app.js';
import app, { AllPublicAccess, AllVisibleEntityFilter, AllVisibleSearchFilter } from '../app.js';
import { PrismaClient } from '../generated/prisma/client.js';
import type { FieldDeclarations } from '../search/fields.js';
import { OpenSearchBackend } from '../search/opensearch/opensearch.js';
import { PostgresBackend } from '../search/postgres/postgres.js';

export type TestBackend = 'OpenSearchBackend' | 'PostgresBackend';

let fastify: FastifyInstance;
let prisma: PrismaClient;
let opensearch: Client;
let search:
  | ReturnType<typeof OpenSearchBackend<typeof testFields>>
  | ReturnType<typeof PostgresBackend<typeof testFields>>;

const testFields = {
  name: { type: 'text', weight: 2, sort: true },
  description: { type: 'text' },
  entityType: { type: 'keyword', facet: true },
  draft: { type: 'boolean' },
} satisfies FieldDeclarations;

export const getTestApp = () => fastify;
export const getTestOpenSearch = () => opensearch;
export const getTestPrisma = () => prisma;

export async function setupIntegrationTests(backend: TestBackend) {
  process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5433/catalog_test';
  process.env.OPENSEARCH_URL = 'http://localhost:9201';
  process.env.NODE_ENV = 'test';

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 5 });
  prisma = new PrismaClient({ adapter });

  opensearch = new Client({
    node: process.env.OPENSEARCH_URL,
  });
  search =
    backend === 'OpenSearchBackend'
      ? OpenSearchBackend({ client: opensearch, fields: testFields, indexName: 'integration-test', refresh: true })
      : PostgresBackend({ prisma, fields: testFields });

  fastify = await buildTestApp();
}

export async function buildTestApp(overrides: Partial<Options> = {}) {
  const instance = Fastify({ logger: false });

  await instance.register(app, {
    prisma,
    search,
    access: AllPublicAccess,
    entityVisibilityFilter: AllVisibleEntityFilter,
    searchVisibilityFilter: AllVisibleSearchFilter,
    fileHandler: {
      get: async () => {
        throw new Error('File handler not implemented in integration tests');
      },
      head: async () => {
        throw new Error('File handler not implemented in integration tests');
      },
    },
    roCrateHandler: {
      get: async () => {
        throw new Error('RO-Crate handler not implemented in integration tests');
      },
      head: async () => {
        throw new Error('RO-Crate head handler not implemented in integration tests');
      },
    },
    ...overrides,
  });

  await instance.ready();

  return instance;
}

export async function teardownIntegrationTests() {
  await cleanupTestData();

  await fastify.close();
  await prisma.$disconnect();
  opensearch.close();
}

export async function cleanupTestData() {
  await prisma.file.deleteMany({});
  await prisma.entity.deleteMany({});

  await opensearch.indices.delete({
    index: 'integration-test',
    ignore_unavailable: true,
  });
}

type TestEntity = { id: string; name: string; description?: string; entityType?: string };

/**
 * Add entities to the database, as a consumer does before indexing their search documents
 */
export const createTestEntities = async (entities: TestEntity[]) => {
  await prisma.entity.createMany({
    data: entities.map(({ id, name, description = '', entityType = 'http://pcdm.org/models#Object' }) => ({
      id,
      name,
      description,
      entityType,
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
    })),
  });
};

export async function seedTestData() {
  await cleanupTestData();

  const testEntities = [
    {
      id: 'http://example.com/entity/1',
      name: 'Test Collection',
      description: 'First test entity',
      entityType: 'http://pcdm.org/models#Collection',
      memberOf: null,
      rootCollection: null,
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'http://example.com/entity/2',
      name: 'Test Object',
      description: 'Second test entity',
      entityType: 'http://pcdm.org/models#Object',
      memberOf: 'http://example.com/entity/1',
      rootCollection: 'http://example.com/entity/1',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      meta: { draft: true },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'http://example.com/entity/3',
      name: 'Test Person',
      description: 'Third test entity',
      entityType: 'http://schema.org/Person',
      memberOf: 'http://example.com/entity/1',
      rootCollection: 'http://example.com/entity/1',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'http://example.com/entity/4',
      name: 'test-audio.wav',
      description: 'Test audio file',
      entityType: 'http://schema.org/MediaObject',
      memberOf: 'http://example.com/entity/2',
      rootCollection: 'http://example.com/entity/1',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://example.com/licences/restricted',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'http://example.com/entity/5',
      name: 'collection-metadata.csv',
      description: 'Collection metadata file',
      entityType: 'http://schema.org/MediaObject',
      memberOf: 'http://example.com/entity/1',
      rootCollection: 'http://example.com/entity/1',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      meta: { draft: true },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await prisma.entity.createMany({
    data: testEntities,
  });

  const testFiles = [
    {
      id: 'http://example.com/entity/4',
      filename: 'test-audio.wav',
      mediaType: 'audio/wav',
      size: BigInt(2048),
      meta: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'http://example.com/entity/5',
      filename: 'collection-metadata.csv',
      mediaType: 'text/csv',
      size: BigInt(512),
      meta: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  await prisma.file.createMany({
    data: testFiles,
  });

  if ('createIndex' in search) {
    await search.createIndex();
  }
  await search.index(
    testEntities.map(({ id, name, description, entityType, meta }) => ({
      id,
      name,
      description,
      entityType,
      ...(meta && { draft: meta.draft }),
    })),
  );

  return testEntities;
}
