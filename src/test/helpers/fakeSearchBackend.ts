import type { BackendSearchCapability, SearchBackend, SearchRequest, SearchResult } from '../../search/backend.js';
import type { RequestContext } from '../../types/context.js';

type Respond = (request: SearchRequest, context: RequestContext) => SearchResult | Promise<SearchResult>;

/**
 * A search backend that records each request and answers with `respond`, by default no hits
 */
export const fakeSearchBackend = (capabilities: Partial<BackendSearchCapability> = {}, respond?: Respond) => {
  const requests: SearchRequest[] = [];

  const backend = {
    capabilities: {
      filters: {},
      facets: {},
      sorts: {},
      searchTypes: { basic: {} },
      geo: { supported: false },
      ...capabilities,
    },
    search: async (request, context) => {
      requests.push(request);

      return respond ? respond(request, context) : { total: 0, hits: [] };
    },
    index: async () => {
      throw new Error('Read-only search backend');
    },
    remove: async () => {
      throw new Error('Read-only search backend');
    },
  } satisfies SearchBackend;

  return { backend, requests };
};
