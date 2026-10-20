import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackendSearchCapability, SearchRequest, SearchResult } from '../search/backend.js';
import { SearchQueryError } from '../search/backend.js';
import { fakeSearchBackend } from '../test/helpers/fakeSearchBackend.js';
import { fastify, fastifyAfter, fastifyBefore, prisma } from '../test/helpers/fastify.js';
import type { AuthorisedEntity } from '../transformers/default.js';
import type { EntityTransformer } from '../types/transformers.js';
import { AllPublicAccess } from '../utils/access.js';
import type { StandardErrorResponse } from '../utils/errors.js';
import { AllVisibleEntityFilter, AllVisibleSearchFilter } from '../utils/visibility.js';
import searchRoute from './search.js';

const entity = (n: number) => ({
  id: `http://example.com/entity/${n}`,
  name: `Entity ${n}`,
  description: `Entity number ${n}`,
  entityType: 'http://pcdm.org/models#Object',
  memberOf: null,
  rootCollection: null,
  metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
  contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
  meta: {},
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

const capabilities = {
  filters: { inLanguage: { type: 'string' as const }, open: { type: 'boolean' as const } },
  facets: { inLanguage: { label: 'Language' }, open: {} },
  sorts: { name: { label: 'Name' } },
};

type SearchBody = {
  total: number;
  searchTime: number;
  entities: (AuthorisedEntity & { searchExtra?: unknown })[];
  facets: Record<string, { name: string; count: number }[]>;
  geohashGrid?: Record<string, number>;
};

type Setup = {
  searchTypes?: BackendSearchCapability['searchTypes'];
  respond?: (request: SearchRequest) => SearchResult | Promise<SearchResult>;
  entityTransformers?: EntityTransformer[];
  searchVisibilityFilter?: () => unknown;
  entityVisibilityFilter?: () => object;
};

const setup = async ({
  searchTypes,
  respond,
  entityTransformers,
  searchVisibilityFilter,
  entityVisibilityFilter,
}: Setup = {}) => {
  const fake = fakeSearchBackend({ ...capabilities, ...(searchTypes && { searchTypes }) }, respond);
  await fastifyBefore();
  prisma.entity.findMany.mockResolvedValue([]);
  await fastify.register(searchRoute, {
    prisma,
    search: fake.backend,
    access: AllPublicAccess,
    entityTransformers,
    entityVisibilityFilter: entityVisibilityFilter ?? AllVisibleEntityFilter,
    // biome-ignore lint/suspicious/noExplicitAny: the interim filter is any OpenSearch query
    searchVisibilityFilter: (searchVisibilityFilter ?? AllVisibleSearchFilter) as any,
  });

  return fake;
};

const search = (payload: object) => fastify.inject({ method: 'POST', url: '/search', payload });

describe('Search Route', () => {
  afterEach(async () => {
    await fastifyAfter();
  });

  describe('the request the backend receives', () => {
    it('fills in defaults', async () => {
      const { requests } = await setup();

      const response = await search({ query: 'test' });

      expect(response.statusCode).toBe(200);
      expect(requests).toEqual([
        {
          searchType: 'basic',
          query: 'test',
          filters: { terms: {}, ranges: {} },
          limit: 100,
          offset: 0,
          sort: 'relevance',
          order: 'asc',
          visibility: { match_all: {} },
        },
      ]);
    });

    it('carries exact-term filters, paging, a declared sort and the search visibility filter', async () => {
      const visibility = { bool: { must_not: { term: { draft: true } } } };
      const { requests } = await setup({ searchVisibilityFilter: async () => visibility });

      await search({
        query: 'test',
        filters: { inLanguage: ['eng', 'nys'], open: ['true'] },
        limit: 10,
        offset: 20,
        sort: 'name',
        order: 'desc',
      });

      expect(requests).toEqual([
        {
          searchType: 'basic',
          query: 'test',
          filters: { terms: { inLanguage: ['eng', 'nys'], open: ['true'] }, ranges: {} },
          limit: 10,
          offset: 20,
          sort: 'name',
          order: 'desc',
          visibility,
        },
      ]);
    });

    it('carries a bounding box and geohash precision', async () => {
      const { requests } = await setup();
      const boundingBox = { topRight: { lat: -10, lng: 155 }, bottomLeft: { lat: -45, lng: 110 } };

      await search({ query: '', boundingBox, geohashPrecision: 3 });

      expect(requests[0]).toMatchObject({ boundingBox, geohashPrecision: 3 });
    });

    it('passes the raw basic query through untouched', async () => {
      const { requests } = await setup();

      await search({ query: '  name: (a OR b) "phrase  ' });

      expect(requests[0].query).toBe('  name: (a OR b) "phrase  ');
    });
  });

  describe('validation against capabilities', () => {
    it.each([
      ['an undeclared filter key', { filters: { mediaType: ['audio/wav'] } }, '/filters/mediaType'],
      ['an undeclared sort', { sort: 'createdAt' }, '/sort'],
      ['an undeclared search type', { searchType: 'advanced' }, '/searchType'],
    ])('rejects %s with a 400 without searching', async (_problem, payload, field) => {
      const { requests } = await setup();

      const response = await search({ query: 'test', ...payload });

      expect(response.statusCode).toBe(400);
      const { error } = response.json<StandardErrorResponse>();
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details?.violations).toEqual([expect.objectContaining({ field })]);
      expect(requests).toHaveLength(0);
    });

    describe('with advanced search declared', () => {
      const searchTypes = { basic: {}, advanced: { fields: { name: {} } } };

      it('passes an empty advanced query as one matching everything', async () => {
        const { requests } = await setup({ searchTypes });

        const response = await search({ searchType: 'advanced', query: ' ' });

        expect(response.statusCode).toBe(200);
        expect(requests[0]).toMatchObject({ searchType: 'advanced', query: { type: 'all' } });
      });

      it('rejects any other advanced query with a 422 on query', async () => {
        const { requests } = await setup({ searchTypes });

        const response = await search({ searchType: 'advanced', query: 'name: test' });

        expect(response.statusCode).toBe(422);
        const { error } = response.json<StandardErrorResponse>();
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.details?.violations).toEqual([expect.objectContaining({ field: 'query' })]);
        expect(requests).toHaveLength(0);
      });
    });

    it('accepts relevance as a sort', async () => {
      const { requests } = await setup();

      const response = await search({ query: 'test', sort: 'relevance' });

      expect(response.statusCode).toBe(200);
      expect(requests[0].sort).toBe('relevance');
    });

    it('requires a query', async () => {
      await setup();

      const response = await search({});

      expect(response.statusCode).toBe(400);
    });
  });

  describe('backend errors', () => {
    it('answers a SearchQueryError with a 422 carrying its message', async () => {
      await setup({
        respond: () => {
          throw new SearchQueryError('Too many clauses');
        },
      });

      const response = await search({ query: 'test' });

      expect(response.statusCode).toBe(422);
      expect(response.json<StandardErrorResponse>().error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Too many clauses',
      });
    });

    it('answers any other error with a generic 500', async () => {
      await setup({
        respond: () => {
          throw Object.assign(new Error('Connection refused'), { statusCode: 400 });
        },
      });

      const response = await search({ query: 'test' });

      expect(response.statusCode).toBe(500);
      expect(response.json<StandardErrorResponse>().error).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    });
  });

  describe('the response', () => {
    it('returns hits as Records in backend order, with access and searchExtra unchanged', async () => {
      await setup({
        respond: () => ({
          total: 42,
          hits: [
            { id: entity(2).id, searchExtra: { score: 2.5, highlight: { name: ['<em>Entity</em> 2'] } } },
            { id: entity(1).id },
          ],
        }),
      });
      prisma.entity.findMany.mockResolvedValueOnce([entity(1), entity(2)]);

      const response = await search({ query: 'entity' });
      const body = response.json<SearchBody>();

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(42);
      expect(body.entities).toEqual([
        {
          id: entity(2).id,
          name: 'Entity 2',
          description: 'Entity number 2',
          entityType: 'http://pcdm.org/models#Object',
          memberOf: null,
          rootCollection: null,
          metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          access: { metadata: true, content: true },
          searchExtra: { score: 2.5, highlight: { name: ['<em>Entity</em> 2'] } },
        },
        expect.not.objectContaining({ searchExtra: expect.anything() }),
      ]);
      expect(body.entities[1].id).toBe(entity(1).id);
    });

    it('loads hits under the entity visibility filter', async () => {
      const hideDrafts = { meta: { path: ['draft'], not: true } };
      await setup({
        entityVisibilityFilter: () => hideDrafts,
        respond: () => ({ total: 1, hits: [{ id: entity(1).id }] }),
      });

      await search({ query: '' });

      expect(prisma.entity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [{ id: { in: [entity(1).id] } }, hideDrafts] } }),
      );
    });

    it('drops and logs hits it cannot load', async () => {
      await setup({ respond: () => ({ total: 2, hits: [{ id: entity(1).id }, { id: entity(2).id }] }) });
      prisma.entity.findMany.mockResolvedValueOnce([entity(1)]);
      const warn = vi.spyOn(fastify.log, 'warn');

      const body = (await search({ query: '' })).json<SearchBody>();

      expect(body.total).toBe(2);
      expect(body.entities.map(({ id }) => id)).toEqual([entity(1).id]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(entity(2).id));
    });

    it('runs the entity transformers on each hit', async () => {
      await setup({
        entityTransformers: [(e) => ({ ...e, name: e.name.toUpperCase() })],
        respond: () => ({ total: 1, hits: [{ id: entity(1).id, searchExtra: { score: 1 } }] }),
      });
      prisma.entity.findMany.mockResolvedValueOnce([entity(1)]);

      const body = (await search({ query: '' })).json<SearchBody>();

      expect(body.entities[0]).toMatchObject({ name: 'ENTITY 1', searchExtra: { score: 1 } });
    });

    it('includes every declared facet, empty when the backend leaves it out', async () => {
      await setup({ respond: () => ({ total: 0, hits: [], facets: { inLanguage: [{ name: 'eng', count: 3 }] } }) });

      const body = (await search({ query: '' })).json<SearchBody>();

      expect(body.facets).toEqual({ inLanguage: [{ name: 'eng', count: 3 }], open: [] });
    });

    it('passes the geohash grid through', async () => {
      await setup({ respond: () => ({ total: 0, hits: [], geohashGrid: { r3: 2 } }) });

      const body = (await search({ query: '' })).json<SearchBody>();

      expect(body.geohashGrid).toEqual({ r3: 2 });
    });

    it('omits the geohash grid when the backend gives none', async () => {
      await setup();

      const body = (await search({ query: '' })).json<SearchBody>();

      expect(body).not.toHaveProperty('geohashGrid');
    });

    it('times the backend call as searchTime', async () => {
      await setup({
        respond: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));

          return { total: 0, hits: [] };
        },
      });

      const body = (await search({ query: '' })).json<SearchBody>();

      expect(body.searchTime).toBeGreaterThanOrEqual(45);
      expect(body.searchTime).toBeLessThan(1000);
    });
  });
});
