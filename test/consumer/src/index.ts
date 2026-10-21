// Type-checked against the packed tarball by scripts/check-consumer-types.sh, never run
import type { Client } from '@opensearch-project/opensearch';
import arocapi, {
  AllPublicAccess,
  AllVisibleSearchFilter,
  type ArocapiPrismaClient,
  type ContentSource,
  type DirectoryStorageMeta,
  type EntityVisibilityFilter,
  type MetadataSource,
  type OcflLocation,
  type OcflStorageMeta,
  type S3StorageMeta,
  type StorageBackend,
} from 'arocapi';
import { OpenSearchBackend } from 'arocapi/search/opensearch';
import { DirectoryStorage } from 'arocapi/storage/directory';
import Fastify from 'fastify';
import type { Entity, File, Prisma, PrismaClient } from './generated/prisma/client.ts';

declare const prisma: PrismaClient;
declare const opensearch: Client;

// A client generated with extra models, a `$extends` client and the client inside `$transaction` are all accepted
export const clients: ArocapiPrismaClient[] = [prisma, prisma.$extends({})];
export const inTransaction = prisma.$transaction(async (tx) => tx satisfies ArocapiPrismaClient);

// @ts-expect-error a plain object isn't a Prisma client
export const notAClient: ArocapiPrismaClient = { notAPrismaClient: true };

// @ts-expect-error Prisma 8 wraps the client in `orm`
export const prisma8: ArocapiPrismaClient = { orm: prisma };

// The visibility filter is checked against the Entity model, whether written inline or with the consumer's own types
export const entityVisibilityFilter: EntityVisibilityFilter = () => ({ entityType: { startsWith: 'http' } });

const ownWhere: Prisma.EntityWhereInput = { memberOf: null };
export const ownTypeFilter: EntityVisibilityFilter = () => ownWhere;

// @ts-expect-error entityTypo isn't an Entity field
export const typoFilter: EntityVisibilityFilter = () => ({ entityTypo: 'x' });

// Halves may be written against the consumer's own row types
export const content: ContentSource = (file: File, entity: Entity, { contentDisposition }) => ({
  type: 'redirect',
  url: `https://files.example.org/${entity.id}/${file.filename}?disposition=${encodeURIComponent(contentDisposition)}`,
});

export const metadata: MetadataSource = async (entity: Entity) => ({ type: 'json', value: entity.meta });

// @ts-expect-error a content half can't return json
export const jsonContent: ContentSource = () => ({ type: 'json', value: {} });

// Mixing halves from different sources
export const storage: StorageBackend = { metadata, content: DirectoryStorage({ root: '/data' }).content };

export const located = DirectoryStorage({
  root: '/data',
  locate: {
    metadata: (entity: Entity) => `${entity.id}/ro-crate-metadata.json`,
    content: async (file: File) => file.filename,
  },
});

// The meta shapes the reference backends read are what an indexer writes
export const metas: Prisma.InputJsonObject[] = [
  { storagePath: 'item/a.wav' } satisfies DirectoryStorageMeta,
  { storageKey: 'item/a.wav' } satisfies S3StorageMeta,
  { ocflObject: 'http://example.org/item', ocflPath: 'a.wav' } satisfies OcflStorageMeta,
];
export const location: OcflLocation = { object: 'http://example.org/item', path: 'a.wav' };

export const fastify = Fastify();

fastify.register(arocapi, {
  prisma,
  search: OpenSearchBackend({ client: opensearch, fields: { name: { type: 'text' } } }),
  access: AllPublicAccess,
  storage,
  entityVisibilityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
});
