import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from '@prisma/adapter-pg';
import { AllPublicAccess, AllVisibleEntityFilter, AllVisibleSearchFilter, type Options } from 'arocapi';
import { OpenSearchBackend } from 'arocapi/search/opensearch';
import { DirectoryStorage } from 'arocapi/storage/directory';
import { PrismaClient } from './generated/prisma/client.ts';

export const options: Options = {
  prisma: new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
  search: OpenSearchBackend({
    client: new Client({ node: process.env.OPENSEARCH_URL }),
    fields: { name: { type: 'text', weight: 2 }, description: { type: 'text' } },
  }),
  storage: DirectoryStorage({ root: '/srv/archive' }),
  entityVisibilityFilter: AllVisibleEntityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
  access: AllPublicAccess,
};
