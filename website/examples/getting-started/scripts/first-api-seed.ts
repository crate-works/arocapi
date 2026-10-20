import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { opensearch, search } from '../src/search.ts';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

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

// Each entity must exist before its search document is indexed
await search.index(entities.map(({ id, name, description, entityType }) => ({ id, name, description, entityType })));

await prisma.$disconnect();
await opensearch.close();
