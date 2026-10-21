import { Client } from '@opensearch-project/opensearch';
import { OpenSearchBackend } from 'arocapi/search/opensearch';

export const opensearch = new Client({ node: process.env.OPENSEARCH_URL });

export const search = OpenSearchBackend({
  client: opensearch,
  fields: {
    name: { type: 'text', weight: 2, sort: true, label: 'Name' },
    description: { type: 'text' },
    entityType: { type: 'keyword', facet: true, label: 'Type' },
  },
});
