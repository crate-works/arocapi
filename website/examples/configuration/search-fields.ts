import { Client } from '@opensearch-project/opensearch';
import { type FieldDeclarations, OpenSearchBackend } from 'arocapi';

const fields = {
  name: { type: 'text', weight: 3, sort: true, label: 'Name' },
  description: { type: 'text' },
  inLanguage: { type: 'keyword', facet: { size: 500 }, label: 'Language' },
  entityType: { type: 'keyword', facet: true, label: 'Type' },
  originatedOn: { type: 'date', filter: true, sort: true, label: 'Date' },
  draft: { type: 'boolean' },
  location: { type: 'geo' },
} satisfies FieldDeclarations;

export const search = OpenSearchBackend({
  client: new Client({ node: process.env.OPENSEARCH_URL }),
  fields,
  indexName: 'catalog',
});

await search.createIndex();

// Values are typed from the declarations: a wrong key or value type fails to compile
await search.index([
  {
    id: 'https://example.org/collection',
    name: 'Songs from the coast',
    description: 'Recordings made in 1971',
    inLanguage: ['eng', 'nys'],
    entityType: 'http://pcdm.org/models#Collection',
    originatedOn: '1971-06',
    draft: false,
    location: { lat: -33.87, lng: 151.21 },
  },
]);

await search.remove(['https://example.org/withdrawn']);
