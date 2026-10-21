import type { Options } from 'arocapi';
import type { FastifyRequest } from 'fastify';

// Your app's session lookup
declare function currentUser(request: FastifyRequest): { id: string } | undefined;

export const guards = {
  entityVisibilityFilter: ({ request }) => (currentUser(request) ? {} : { id: { in: [] } }),
  searchVisibilityFilter: ({ request }) => (currentUser(request) ? {} : { OR: [] }),
  isAuthenticated: ({ request }) => currentUser(request) !== undefined,
  promptLoginForHidden: true,
} satisfies Partial<Options>;
