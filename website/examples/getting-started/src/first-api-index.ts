import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import arocapi, {
  AllPublicAccess,
  AllVisibleEntityFilter,
  AllVisibleSearchFilter,
  type FileHandler,
  type RoCrateHandler,
} from 'arocapi';
import Fastify from 'fastify';
import { PrismaClient } from './generated/prisma/client.ts';
import { search } from './search.ts';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Where each entity's RO-Crate and each file is stored, kept in their meta column
type StoredMeta = { storagePath: string };

// An entity without its own RO-Crate, like the file entity added below, has no meta
const crateStat = async (meta: unknown) => {
  if (!meta) {
    return false;
  }
  const { storagePath } = meta as StoredMeta;
  const { size, mtime } = await stat(storagePath);

  return { storagePath, metadata: { contentType: 'application/ld+json', contentLength: size, lastModified: mtime } };
};

const fileHandler: FileHandler = {
  head: async (file) => ({
    contentType: file.mediaType,
    contentLength: Number(file.size),
  }),
  get: async (file) => {
    const { storagePath } = file.meta as StoredMeta;

    return {
      type: 'file',
      path: storagePath,
      metadata: { contentType: file.mediaType, contentLength: Number(file.size) },
    };
  },
};

const roCrateHandler: RoCrateHandler = {
  head: async (entity) => {
    const crate = await crateStat(entity.meta);

    return crate ? crate.metadata : false;
  },
  get: async (entity) => {
    const crate = await crateStat(entity.meta);
    if (!crate) {
      return false;
    }

    return { type: 'stream', stream: createReadStream(crate.storagePath), metadata: crate.metadata };
  },
};

const fastify = Fastify({ logger: true });

await fastify.register(arocapi, {
  prisma,
  search,
  entityVisibilityFilter: AllVisibleEntityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
  access: AllPublicAccess,
  fileHandler,
  roCrateHandler,
});

await fastify.listen({ port: 3000 });
