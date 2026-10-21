import type { FastifyPluginAsync } from 'fastify';
import type { SearchBackend } from '../search/backend.js';

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

  fastify.get('/capabilities', async () => document);
};

export default capabilities;
