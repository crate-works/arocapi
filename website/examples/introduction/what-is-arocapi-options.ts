import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  AllPublicAccess,
  AllVisibleEntityFilter,
  AllVisibleSearchFilter,
  type FileHandler,
  OpenSearchBackend,
  type Options,
  type RoCrateHandler,
} from 'arocapi';
import { PrismaClient } from './generated/prisma/client.ts';

// Your storage, see Handlers
declare const fileHandler: FileHandler;
declare const roCrateHandler: RoCrateHandler;

export const options: Options = {
  prisma: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
  search: OpenSearchBackend({
    client: new Client({ node: process.env.OPENSEARCH_URL }),
    fields: { name: { type: 'text', weight: 2 }, description: { type: 'text' } },
  }),
  fileHandler,
  roCrateHandler,
  entityVisibilityFilter: AllVisibleEntityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
  access: AllPublicAccess,
};
