// Type-checked against the packed tarball by scripts/check-consumer-types.sh, never run
import type { Client } from '@opensearch-project/opensearch';
import { type BackendSearchCapability, capabilitiesFromFields, OpenSearchBackend, type SearchDocument } from 'arocapi';

declare const client: Client;

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
