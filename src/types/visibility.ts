import type { Prisma } from '../generated/prisma/client.js';
import type { FieldDeclarations } from '../search/fields.js';
import type { SearchVisibilityWhere } from '../search/visibility.js';
import type { RequestContext } from './context.js';

/**
 * Entity visibility filter - required
 * Returns a Prisma condition matching the entities visible to this request
 */
export type EntityVisibilityFilter = (
  context: RequestContext,
) => Promise<Prisma.EntityWhereInput> | Prisma.EntityWhereInput;

/**
 * Search visibility filter - required
 * Returns a condition over `id` and the search backend's declared fields matching the entities visible to this request
 * Must agree with the entity visibility filter
 */
export type SearchVisibilityFilter<Fields extends FieldDeclarations = FieldDeclarations> = (
  context: RequestContext,
) => Promise<SearchVisibilityWhere<Fields>> | SearchVisibilityWhere<Fields>;
