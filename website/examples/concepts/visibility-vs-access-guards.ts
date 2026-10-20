import { LicenceAccess, type Options } from 'arocapi';
import type { FastifyRequest } from 'fastify';

// Your app's session lookup
declare function currentUser(request: FastifyRequest): { licences: string[] } | undefined;

const openLicence = 'https://creativecommons.org/licenses/by/4.0/';

export const guards = {
  entityVisibilityFilter: () => ({ meta: { path: ['published'], equals: true } }),
  searchVisibilityFilter: () => ({ published: true }),
  isAuthenticated: ({ request }) => currentUser(request) !== undefined,
  access: LicenceAccess({
    hasLicence: (licenceId, { request }) =>
      licenceId === openLicence || (currentUser(request)?.licences.includes(licenceId) ?? false),
    authorisationUrl: (licenceId) => `https://rems.example.org/apply?licence=${encodeURIComponent(licenceId)}`,
  }),
} satisfies Partial<Options>;
