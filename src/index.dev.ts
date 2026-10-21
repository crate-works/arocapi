import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import Fastify from 'fastify';

import arocapi, {
  AllPublicAccess,
  AllVisibleEntityFilter,
  AllVisibleSearchFilter,
  type EntityTransformer,
  type FieldDeclarations,
  type MetadataSource,
} from './app.js';
import { PrismaClient } from './generated/prisma/client.js';
import { OpenSearchBackend } from './search/opensearch/opensearch.js';
import { DirectoryStorage } from './storage/directory/directory.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

if (!process.env.OPENSEARCH_URL) {
  throw new Error('OPENSEARCH_URL environment variable is not set');
}
const opensearchUrl = process.env.OPENSEARCH_URL;
const opensearch = new Client({ node: opensearchUrl });

// Keep in step with example/data/seed.ts and scripts/loadEntities.ts
const fields = {
  name: { type: 'text', weight: 2, sort: true, label: 'Name' },
  description: { type: 'text' },
  entityType: { type: 'keyword', facet: true, label: 'Type' },
  inLanguage: { type: 'keyword', facet: true, label: 'Language' },
  mediaType: { type: 'keyword', facet: true, label: 'Media type' },
  communicationMode: { type: 'keyword', facet: true, label: 'Communication mode' },
  location: { type: 'geo' },
} satisfies FieldDeclarations;

const directory = DirectoryStorage({ root: 'example/data' });

// File entities share their item's crate, with its root remapped to the file
const metadata: MetadataSource = async (entity, context) => {
  const { storagePath, remapRootTo } = (entity.meta ?? {}) as { storagePath?: string; remapRootTo?: string };
  if (!remapRootTo || !storagePath) {
    return directory.metadata(entity, context);
  }

  const rocrate = JSON.parse(await readFile(join('example/data', storagePath), 'utf-8')) as {
    '@graph'?: Array<{ '@id': string; about?: { '@id': string } }>;
  };
  const descriptor = rocrate['@graph']?.find((node) => node['@id'] === 'ro-crate-metadata.json');
  if (!descriptor?.about) {
    return null;
  }

  descriptor.about['@id'] = remapRootTo;

  return { type: 'json', value: rocrate };
};

const oniTransformer: EntityTransformer = (entity) => {
  return {
    ...entity,
    accessControl: 'Public',
    counts: {
      collections: 0,
      objects: 0,
      files: 0,
    },
  };
};

const fastify = Fastify({
  logger: true,
});
fastify.register(arocapi, {
  prisma,
  search: OpenSearchBackend({ client: opensearch, fields }),
  storage: { metadata, content: directory.content },
  access: AllPublicAccess,
  entityTransformers: [oniTransformer],
  entityVisibilityFilter: AllVisibleEntityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
});

const start = async () => {
  try {
    await fastify.listen({ port: 9000 });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
