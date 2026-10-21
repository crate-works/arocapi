import { PrismaPg } from '@prisma/adapter-pg';
import arocapi, { AllPublicAccess, AllVisibleEntityFilter, AllVisibleSearchFilter } from 'arocapi';
import { DirectoryStorage } from 'arocapi/storage/directory';
import Fastify from 'fastify';
import { PrismaClient } from './generated/prisma/client.ts';
import { search } from './search.ts';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const fastify = Fastify({ logger: true });

await fastify.register(arocapi, {
  prisma,
  search,
  entityVisibilityFilter: AllVisibleEntityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
  access: AllPublicAccess,
  // Each entity's RO-Crate and each file sit below ./data, at the storagePath in their meta
  storage: DirectoryStorage({ root: './data' }),
});

await fastify.listen({ port: 3000 });
