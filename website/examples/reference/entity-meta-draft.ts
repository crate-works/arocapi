import type { EntityVisibilityFilter, SearchVisibilityFilter } from 'arocapi';
import { Prisma } from './generated/prisma/client.ts';

export const entityVisibilityFilter: EntityVisibilityFilter = () => ({
  OR: [{ meta: { path: ['draft'], equals: Prisma.AnyNull } }, { meta: { path: ['draft'], not: true } }],
});

// With draft declared as { type: 'boolean' } and indexed from meta.draft
export const searchVisibilityFilter: SearchVisibilityFilter<{ draft: { type: 'boolean' } }> = () => ({
  draft: { not: true },
});
