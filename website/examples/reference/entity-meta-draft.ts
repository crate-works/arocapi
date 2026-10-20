import type { EntityVisibilityFilter, SearchVisibilityFilter } from 'arocapi';
import { Prisma } from './generated/prisma/client.ts';

export const entityVisibilityFilter: EntityVisibilityFilter = () => ({
  OR: [{ meta: { path: ['draft'], equals: Prisma.AnyNull } }, { meta: { path: ['draft'], not: true } }],
});

export const searchVisibilityFilter: SearchVisibilityFilter = () => ({
  bool: { must_not: { term: { 'meta.draft': true } } },
});
