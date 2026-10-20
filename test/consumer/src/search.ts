// Type-checked against the packed tarball by scripts/check-consumer-types.sh, never run
import type { Client } from '@opensearch-project/opensearch';
import {
  type BackendSearchCapability,
  capabilitiesFromFields,
  OpenSearchBackend,
  PostgresBackend,
  type PostgresClient,
  type SearchBackend,
  type SearchDocument,
  SearchQueryError,
  type SearchResult,
} from 'arocapi';

declare const client: Client;
declare const prisma: PostgresClient;

const fields = {
  name: { type: 'text', sort: true },
  inLanguage: { type: 'keyword', facet: { size: 500 } },
  originatedOn: { type: 'date', filter: true },
  pages: { type: 'number' },
  draft: { type: 'boolean' },
  location: { type: 'geo' },
} as const;

export const backend = OpenSearchBackend({ client, fields, indexName: 'catalog' });
export const capabilities: BackendSearchCapability = capabilitiesFromFields(fields);

export const doc: SearchDocument<typeof fields> = {
  id: 'http://example.com/1',
  name: 'Greeting',
  inLanguage: ['eng', 'nys'],
  originatedOn: '2001',
  pages: 12,
  draft: false,
  location: { lat: -33.87, lng: 151.21 },
};

// Every field may be missing
export const indexed = backend.index([doc, { id: 'http://example.com/2' }]);

// @ts-expect-error title isn't declared
export const undeclared = backend.index([{ id: 'http://example.com/1', title: 'Greeting' }]);

// @ts-expect-error pages is a number
export const wrongType: SearchDocument<typeof fields> = { id: 'http://example.com/1', pages: '12' };

// @ts-expect-error name is a sort field, so it takes a single value
export const sortArray: SearchDocument<typeof fields> = { id: 'http://example.com/1', name: ['Greeting'] };

// @ts-expect-error a geo field holds a single point
export const points: SearchDocument<typeof fields> = { id: 'http://example.com/1', location: [{ lat: 1, lng: 2 }] };

// @ts-expect-error a search document needs an id
export const noId: SearchDocument<typeof fields> = { name: 'Greeting' };

// Declarations written inline are inferred as literals
export const inline = OpenSearchBackend({ client, fields: { pages: { type: 'number' } } }).index([
  // @ts-expect-error pages is a number
  { id: 'http://example.com/1', pages: '12' },
]);

// The reference backends satisfy the contract
export const openSearchBackend: SearchBackend = backend;
export const postgresBackend: Omit<SearchBackend, 'search'> = PostgresBackend({ prisma, fields });

// A custom backend is an object literal
export const custom: SearchBackend = {
  capabilities: { filters: {}, facets: {}, sorts: {}, searchTypes: { basic: {} }, geo: { supported: false } },
  search: async (request): Promise<SearchResult> => {
    if (request.searchType === 'basic' && request.query.length > 100) {
      throw new SearchQueryError('Too long');
    }

    return { total: 1, hits: [{ id: 'http://example.com/1', searchExtra: { score: 1 } }] };
  },
  index: async () => {
    throw new Error('Read-only');
  },
  remove: async () => {
    throw new Error('Read-only');
  },
};

export const noTotal: SearchBackend = {
  ...custom,
  // @ts-expect-error a result needs an exact total
  search: async () => ({ hits: [] }),
};
