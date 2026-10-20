import type { RequestContext } from '../types/context.js';
import type { BackendSearchCapability, GeoPoint, SearchDocument } from './fields.js';
import type { SearchVisibilityWhere } from './visibility.js';

export type { BackendSearchCapability } from './fields.js';

/**
 * A parsed advanced query
 */
export type AdvancedQuery =
  | { type: 'and' | 'or'; clauses: AdvancedQuery[] }
  | { type: 'not'; clause: AdvancedQuery }
  | { type: 'match'; field: string; value: string; phrase: boolean }
  | { type: 'all' };

/** Date bounds are UTC instants */
export type RangeBound = number | Date;

export type RangeFilter = { gte?: RangeBound; lte?: RangeBound };

export type BoundingBox = { topRight: GeoPoint; bottomLeft: GeoPoint };

/**
 * A validated, normalised search, as arocapi hands it to a search backend
 */
export type SearchRequest = (
  | { searchType: 'basic'; query: string }
  | { searchType: 'advanced'; query: AdvancedQuery }
) & {
  filters: {
    /** Field name → values, any of which matches */
    terms: Record<string, string[]>;
    /** Field name → ranges, any of which matches; date and number filters always arrive here, exact values as ranges */
    ranges: Record<string, RangeFilter[]>;
  };
  boundingBox?: BoundingBox;
  geohashPrecision?: number;
  limit: number;
  offset: number;
  /** A declared sort, or `relevance`: best match first, stable for an empty query */
  sort: string;
  order: 'asc' | 'desc';
  /** The resolved `searchVisibilityFilter`, which the backend checks and applies to hits, total and facets */
  visibility: SearchVisibilityWhere;
};

export type SearchExtra = { score?: number; highlight?: Record<string, string[]> };

export type FacetBucket = { name: string; count: number };

export type SearchResult = {
  /** Exact */
  total: number;
  /** Ordered */
  hits: { id: string; searchExtra?: SearchExtra }[];
  facets?: Record<string, FacetBucket[]>;
  geohashGrid?: Record<string, number>;
};

/**
 * A search backend: arocapi validates each request against `capabilities`, the backend only searches
 */
export interface SearchBackend {
  /** What `/capabilities` publishes and arocapi validates requests against */
  readonly capabilities: BackendSearchCapability;
  search(request: SearchRequest, context: RequestContext): Promise<SearchResult>;
  /** Upsert search documents; each entity must exist first */
  index(docs: SearchDocument[], options?: { tx?: unknown }): Promise<void>;
  /** Remove search documents, ignoring ids that aren't indexed */
  remove(ids: string[]): Promise<void>;
}

/**
 * Thrown by a search backend for a query it can't run; arocapi answers 422 with its message
 */
export class SearchQueryError extends Error {
  override name = 'SearchQueryError';
}
