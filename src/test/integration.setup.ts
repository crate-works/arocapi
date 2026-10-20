import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { Options } from '../app.js';
import app, { AllPublicAccess, AllVisibleEntityFilter, AllVisibleSearchFilter } from '../app.js';
import { PrismaClient } from '../generated/prisma/client.js';

let fastify: FastifyInstance;
let prisma: PrismaClient;
let opensearch: Client;

export const getTestApp = () => fastify;

export async function setupIntegrationTests() {
  process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5433/catalog_test';
  process.env.OPENSEARCH_URL = 'http://localhost:9201';
  process.env.NODE_ENV = 'test';

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 5 });
  prisma = new PrismaClient({ adapter });

  opensearch = new Client({
    node: process.env.OPENSEARCH_URL,
  });

  fastify = await buildTestApp();
}

export async function buildTestApp(overrides: Partial<Options> = {}) {
  const instance = Fastify({ logger: false });

  await instance.register(app, {
    prisma,
    opensearch,
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
    index: 'entities',
    ignore_unavailable: true,
  });
}

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

  await opensearch.indices.create({
    index: 'entities',
    body: {
      mappings: {
        properties: {
          id: { type: 'keyword' },
          name: {
            type: 'text',
            fields: {
              keyword: { type: 'keyword' },
            },
          },
          description: { type: 'text' },
          entityType: { type: 'keyword' },
          memberOf: { type: 'keyword' },
          rootCollection: { type: 'keyword' },
          location: { type: 'geo_point' },
          inLanguage: { type: 'keyword' },
          mediaType: { type: 'keyword' },
          communicationMode: { type: 'keyword' },
        },
      },
    },
  });

  const testDocs = testEntities.flatMap((entity) => [{ index: { _index: 'entities', _id: entity.id } }, entity]);

  await opensearch.bulk({
    body: testDocs,
    refresh: true,
  });

  return testEntities;
}
