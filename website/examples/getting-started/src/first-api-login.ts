import arocapi, {
  AllVisibleEntityFilter,
  AllVisibleSearchFilter,
  type FileHandler,
  type IsAuthenticated,
  LicenceAccess,
  type Options,
  type RoCrateHandler,
} from 'arocapi';
import type { FastifyInstance } from 'fastify';

// Unchanged from the version above
declare const fastify: FastifyInstance;
declare const prisma: Options['prisma'];
declare const search: Options['search'];
declare const fileHandler: FileHandler;
declare const roCrateHandler: RoCrateHandler;

const openLicences = new Set(['https://creativecommons.org/licenses/by/4.0/']);

const apiToken = process.env.API_TOKEN;

const isAuthenticated: IsAuthenticated = ({ request }) =>
  Boolean(apiToken) && request.headers.authorization === `Bearer ${apiToken}`;

const access = LicenceAccess({
  hasLicence: async (licenceId, context) => openLicences.has(licenceId) || (await isAuthenticated(context)),
  authorisationUrl: (licenceId) => `https://example.org/request-access?licence=${encodeURIComponent(licenceId)}`,
});

await fastify.register(arocapi, {
  prisma,
  search,
  entityVisibilityFilter: AllVisibleEntityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
  access,
  isAuthenticated,
  fileHandler,
  roCrateHandler,
});
