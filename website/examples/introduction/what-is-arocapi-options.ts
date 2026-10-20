import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  AllPublicAccess,
  AllVisibleEntityFilter,
  AllVisibleSearchFilter,
  type FileHandler,
  type Options,
  type RoCrateHandler,
} from 'arocapi';
import { PrismaClient } from './generated/prisma/client.ts';

// Your storage, see Handlers
declare const fileHandler: FileHandler;
declare const roCrateHandler: RoCrateHandler;

export const options: Options = {
  prisma: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
  opensearch: new Client({ node: process.env.OPENSEARCH_URL }),
  fileHandler,
  roCrateHandler,
  entityVisibilityFilter: AllVisibleEntityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
  access: AllPublicAccess,
};
