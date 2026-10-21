import type { EntityVisibilityFilter, SearchVisibilityFilter } from 'arocapi';
import type { FastifyRequest } from 'fastify';

// Your app's lookup of the top-level collections a request may not see, such as withdrawn ones
declare function hiddenCollections(request: FastifyRequest): Promise<string[]>;

// Your search backend's field declarations, with rootCollection stored for visibility only
const fields = {
  name: { type: 'text' },
  rootCollection: { type: 'keyword' },
} as const;

// Hides each collection and, through rootCollection, everything in it
export const entityVisibilityFilter: EntityVisibilityFilter = async ({ request }) => {
  const hidden = await hiddenCollections(request);

  return { id: { notIn: hidden }, OR: [{ rootCollection: null }, { rootCollection: { notIn: hidden } }] };
};

export const searchVisibilityFilter: SearchVisibilityFilter<typeof fields> = async ({ request }) => {
  const hidden = await hiddenCollections(request);

  return { id: { notIn: hidden }, rootCollection: { notIn: hidden } };
};
