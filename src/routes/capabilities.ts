import type { FastifyPluginAsync } from 'fastify';
import type { SearchBackend } from '../search/backend.js';
import type { CacheControlConfig } from '../utils/headers.js';

const SPEC_VERSION = '0.5.0';

type CapabilitiesRouteOptions = {
  search: SearchBackend;
};

const capabilities: FastifyPluginAsync<CapabilitiesRouteOptions> = async (fastify, opts) => {
  const document = {
    apiVersion: SPEC_VERSION,
    deposit: { supported: false },
    tombstonePolicy: '404',
    extensions: {},
    search: opts.search.capabilities,
  };

  // The same for every user, so shared caches may store it
  const config: CacheControlConfig = { cacheControl: null };
  fastify.get('/capabilities', { config }, async () => document);
};

export default capabilities;
