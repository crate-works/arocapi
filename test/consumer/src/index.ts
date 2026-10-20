// Type-checked against the packed tarball by scripts/check-consumer-types.sh, never run
import type { Client } from '@opensearch-project/opensearch';
import arocapi, {
  AllPublicAccess,
  AllVisibleSearchFilter,
  type ArocapiPrismaClient,
  type EntityVisibilityFilter,
  type FileHandler,
  type RoCrateHandler,
} from 'arocapi';
import Fastify from 'fastify';
import type { File, Prisma, PrismaClient } from './generated/prisma/client.ts';

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

// Handlers may be written against the consumer's own row types
export const fileHandler: FileHandler = {
  get: (file: File) => ({ type: 'redirect', url: `https://files.example.org/${file.id}` }),
  head: (file: File) => ({ contentType: file.mediaType, contentLength: Number(file.size) }),
};

export const roCrateHandler: RoCrateHandler = {
  get: () => false,
  head: () => false,
};

export const fastify = Fastify();

fastify.register(arocapi, {
  prisma,
  opensearch,
  access: AllPublicAccess,
  fileHandler,
  roCrateHandler,
  entityVisibilityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
});
