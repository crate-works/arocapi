import { resolve } from 'node:path';
import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const opensearch = new Client({ node: process.env.OPENSEARCH_URL });

const licence = 'https://creativecommons.org/licenses/by/4.0/';
const collectionId = 'https://example.org/collection';
const fileId = 'https://example.org/collection/hello.txt';

const entities = [
  {
    id: collectionId,
    name: 'My first collection',
    description: 'A collection with one file',
    entityType: 'http://pcdm.org/models#Collection',
    memberOf: null,
    rootCollection: null,
    metadataLicenseId: licence,
    contentLicenseId: licence,
  },
  {
    id: fileId,
    name: 'hello.txt',
    description: 'A greeting',
    entityType: 'http://schema.org/MediaObject',
    memberOf: collectionId,
    rootCollection: collectionId,
    metadataLicenseId: licence,
    contentLicenseId: licence,
  },
];

await prisma.entity.create({
  data: { ...entities[0], meta: { storagePath: resolve('data/ro-crate-metadata.json') } },
});
await prisma.entity.create({ data: entities[1] });
await prisma.file.create({
  data: {
    id: fileId,
    filename: 'hello.txt',
    mediaType: 'text/plain',
    size: 19,
    meta: { storagePath: resolve('data/hello.txt') },
  },
});

await opensearch.bulk({
  body: entities.flatMap((entity) => [{ index: { _index: 'entities', _id: entity.id } }, entity]),
  refresh: true,
});

await prisma.$disconnect();
