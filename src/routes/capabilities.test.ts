import { afterEach, describe, expect, it, vi } from 'vitest';

import app, {
  AllPublicAccess,
  AllVisibleEntityFilter,
  AllVisibleSearchFilter,
  capabilitiesFromFields,
  type Options,
} from '../app.js';
import { fakeSearchBackend } from '../test/helpers/fakeSearchBackend.js';
import { fastify, fastifyAfter, fastifyBefore, prisma } from '../test/helpers/fastify.js';

const registerApp = async (options: Partial<Options> = {}) => {
  await fastifyBefore();
  await fastify.register(app, {
    prisma,
    search: fakeSearchBackend().backend,
    access: AllPublicAccess,
    fileHandler: { get: vi.fn(), head: vi.fn() },
    roCrateHandler: { get: vi.fn(), head: vi.fn() },
    entityVisibilityFilter: AllVisibleEntityFilter,
    searchVisibilityFilter: AllVisibleSearchFilter,
    ...options,
  });
};

const getCapabilities = async () => {
  const response = await fastify.inject({ method: 'GET', url: '/capabilities' });

  return { statusCode: response.statusCode, body: response.json() };
};

describe('Capabilities Route', () => {
  afterEach(async () => {
    await fastifyAfter();
  });

  describe('GET /capabilities', () => {
    it('reports RO-Crate API v0.5.0 with the search backend capabilities', async () => {
      await registerApp({
        search: fakeSearchBackend(
          capabilitiesFromFields({
            name: { type: 'text', sort: true, label: 'Name' },
            inLanguage: { type: 'keyword', facet: true, label: 'Language' },
            draft: { type: 'boolean' },
          }),
        ).backend,
      });

      const { statusCode, body } = await getCapabilities();

      expect(statusCode).toBe(200);
      expect(body).toEqual({
        apiVersion: '0.5.0',
        deposit: { supported: false },
        tombstonePolicy: '404',
        extensions: {},
        search: {
          filters: { inLanguage: { type: 'string', label: 'Language' } },
          facets: { inLanguage: { label: 'Language' } },
          sorts: { name: { label: 'Name' } },
          searchTypes: { basic: {} },
          geo: { supported: false },
        },
      });
    });

    it('should not run the access function', async () => {
      const access = vi.fn(() => {
        throw new Error('Unauthorised');
      });

      await registerApp({ access });

      const { statusCode } = await getCapabilities();

      expect(statusCode).toBe(200);
      expect(access).not.toHaveBeenCalled();
    });
  });
});
