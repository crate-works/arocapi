import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackendSearchCapability, SearchRequest, SearchResult } from '../search/backend.js';
import { SearchQueryError } from '../search/backend.js';
import { fakeSearchBackend } from '../test/helpers/fakeSearchBackend.js';
import { fastify, fastifyAfter, fastifyBefore, prisma } from '../test/helpers/fastify.js';
import type { AuthorisedEntity } from '../transformers/default.js';
import type { EntityTransformer } from '../types/transformers.js';
import type { SearchVisibilityFilter } from '../types/visibility.js';
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
  extraCapabilities?: Partial<BackendSearchCapability>;
  respond?: (request: SearchRequest) => SearchResult | Promise<SearchResult>;
  entityTransformers?: EntityTransformer[];
  searchVisibilityFilter?: SearchVisibilityFilter;
  entityVisibilityFilter?: () => object;
};

const setup = async ({
  searchTypes,
  respond,
  entityTransformers,
  searchVisibilityFilter,
  entityVisibilityFilter,
  extraCapabilities,
}: Setup = {}) => {
  const fake = fakeSearchBackend(
    { ...capabilities, ...(searchTypes && { searchTypes }), ...extraCapabilities },
    respond,
  );
  await fastifyBefore();
  prisma.entity.findMany.mockResolvedValue([]);
  await fastify.register(searchRoute, {
    prisma,
    search: fake.backend,
    access: AllPublicAccess,
    entityTransformers,
    entityVisibilityFilter: entityVisibilityFilter ?? AllVisibleEntityFilter,
    searchVisibilityFilter: searchVisibilityFilter ?? AllVisibleSearchFilter,
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
          visibility: {},
        },
      ]);
    });

    it('carries exact-term filters, paging, a declared sort and the search visibility filter', async () => {
      const visibility = { draft: { not: true }, id: { notIn: ['http://example.com/entity/9'] } };
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
      const { requests } = await setup({ extraCapabilities: { geo: { supported: true } } });
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

  describe('ranges and geo', () => {
    const extraCapabilities = {
      filters: {
        inLanguage: { type: 'string' as const },
        open: { type: 'boolean' as const },
        datePublished: { type: 'date' as const },
        pages: { type: 'number' as const },
      },
    };
    const geo = { ...extraCapabilities, geo: { supported: true } };
    const box = { topRight: { lat: -10, lng: 155 }, bottomLeft: { lat: -45, lng: 110 } };

    const filtersSent = async (filters: object) => {
      const { requests } = await setup({ extraCapabilities });

      const response = await search({ query: '', filters });

      expect(response.statusCode).toBe(200);

      return requests[0].filters;
    };

    it('turns a calendar-date range into UTC instants covering whole days', async () => {
      expect(await filtersSent({ datePublished: { gte: '2001-01-01', lte: '2001-12-31' } })).toEqual({
        terms: {},
        ranges: {
          datePublished: [{ gte: new Date('2001-01-01T00:00:00.000Z'), lte: new Date('2001-12-31T23:59:59.999Z') }],
        },
      });
    });

    it('uses a date-time bound as given, reading one with no offset as UTC', async () => {
      const filters = await filtersSent({
        datePublished: [{ gte: '2001-06-01T10:00:00+10:00' }, { lte: '1999-01-01T12:30:00.5' }],
      });

      expect(filters.ranges).toEqual({
        datePublished: [{ gte: new Date('2001-06-01T00:00:00.000Z') }, { lte: new Date('1999-01-01T12:30:00.500Z') }],
      });
    });

    it('turns exact dates into ranges: a calendar date covers its UTC day, a date-time is that instant', async () => {
      const filters = await filtersSent({ datePublished: ['2001-02-03', '2001-02-05T01:02:03Z'] });

      expect(filters).toEqual({
        terms: {},
        ranges: {
          datePublished: [
            { gte: new Date('2001-02-03T00:00:00.000Z'), lte: new Date('2001-02-03T23:59:59.999Z') },
            { gte: new Date('2001-02-05T01:02:03.000Z'), lte: new Date('2001-02-05T01:02:03.000Z') },
          ],
        },
      });
    });

    it('turns number ranges and exact numbers into numeric ranges', async () => {
      const filters = await filtersSent({ pages: [{ gte: 5 }, { gte: 1, lte: 2.5 }] });
      const exact = await filtersSent({ pages: ['5', '10.5'] });

      expect(filters).toEqual({ terms: {}, ranges: { pages: [{ gte: 5 }, { gte: 1, lte: 2.5 }] } });
      expect(exact.ranges).toEqual({
        pages: [
          { gte: 5, lte: 5 },
          { gte: 10.5, lte: 10.5 },
        ],
      });
    });

    it('keeps string and boolean filters as exact terms beside ranges', async () => {
      expect(await filtersSent({ inLanguage: ['eng'], open: ['false'], pages: { lte: 3 } })).toEqual({
        terms: { inLanguage: ['eng'], open: ['false'] },
        ranges: { pages: [{ lte: 3 }] },
      });
    });

    it.each([
      ['a range on a string filter', { inLanguage: { gte: 'a' } }, 'inLanguage'],
      ['a range on a boolean filter', { open: [{ gte: 'false' }] }, 'open'],
      ['a year as a date bound', { datePublished: { gte: '2001' } }, 'datePublished'],
      ['a year and month as a date bound', { datePublished: { lte: '2001-12' } }, 'datePublished'],
      ['an impossible date', { datePublished: { lte: '2001-02-30' } }, 'datePublished'],
      ['a number as a date bound', { datePublished: { gte: 2001 } }, 'datePublished'],
      ['a string as a number bound', { pages: { gte: '5' } }, 'pages'],
      ['a lower bound above the upper bound', { pages: { gte: 6, lte: 5 } }, 'pages'],
      [
        'a lower date bound after the upper one',
        { datePublished: { gte: '2002-01-01', lte: '2001-12-31' } },
        'datePublished',
      ],
      ['a partial exact date', { datePublished: ['2001'] }, 'datePublished'],
      ['a non-numeric exact number', { pages: ['many'] }, 'pages'],
    ])('rejects %s with a 400 naming the filter', async (_problem, filters, key) => {
      const { requests } = await setup({ extraCapabilities });

      const response = await search({ query: '', filters });

      expect(response.statusCode).toBe(400);
      const { error } = response.json<StandardErrorResponse>();
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details?.violations).toEqual([expect.objectContaining({ field: `/filters/${key}` })]);
      expect(requests).toHaveLength(0);
    });

    it.each([
      ['a range with no bound', { pages: {} }],
      ['a range with an unknown bound', { pages: { gt: 5 } }],
      ['an array mixing ranges and exact values', { pages: [{ gte: 1 }, '2'] }],
    ])('rejects %s with a 400', async (_problem, filters) => {
      const { requests } = await setup({ extraCapabilities });

      const response = await search({ query: '', filters });

      expect(response.statusCode).toBe(400);
      expect(response.json<StandardErrorResponse>().error.code).toBe('VALIDATION_ERROR');
      expect(requests).toHaveLength(0);
    });

    it.each([
      ['a bounding box', { boundingBox: box }, '/boundingBox'],
      ['a geohash precision', { boundingBox: box, geohashPrecision: 3 }, '/geohashPrecision'],
    ])('rejects %s with a 400 when geo is not supported', async (_param, payload, field) => {
      const { requests } = await setup({ extraCapabilities });

      const response = await search({ query: '', ...payload });

      expect(response.statusCode).toBe(400);
      const { error } = response.json<StandardErrorResponse>();
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details?.violations).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
      expect(requests).toHaveLength(0);
    });

    it.each([
      ['a geohash precision without a bounding box', { geohashPrecision: 3 }, '/geohashPrecision'],
      [
        'a bounding box upside down',
        { boundingBox: { topRight: { lat: -45, lng: 155 }, bottomLeft: { lat: -10, lng: 110 } } },
        '/boundingBox',
      ],
    ])('rejects %s with a 400', async (_problem, payload, field) => {
      const { requests } = await setup({ extraCapabilities: geo });

      const response = await search({ query: '', ...payload });

      expect(response.statusCode).toBe(400);
      expect(response.json<StandardErrorResponse>().error.details?.violations).toEqual([
        expect.objectContaining({ field }),
      ]);
      expect(requests).toHaveLength(0);
    });

    it('rejects a latitude out of range with a 400', async () => {
      const { requests } = await setup({ extraCapabilities: geo });

      const response = await search({ query: '', boundingBox: { ...box, topRight: { lat: 91, lng: 155 } } });

      expect(response.statusCode).toBe(400);
      expect(requests).toHaveLength(0);
    });

    it('passes a box crossing the antimeridian through', async () => {
      const { requests } = await setup({ extraCapabilities: geo });
      const boundingBox = { topRight: { lat: 10, lng: -170 }, bottomLeft: { lat: -10, lng: 170 } };

      const response = await search({ query: '', boundingBox });

      expect(response.statusCode).toBe(200);
      expect(requests[0].boundingBox).toEqual(boundingBox);
    });
  });

  describe('advanced queries', () => {
    const searchTypes = {
      basic: {},
      advanced: { fields: { name: {}, description: {}, inLanguage: {} } },
    };

    const treeFor = async (query: string) => {
      const { requests } = await setup({ searchTypes });

      const response = await search({ searchType: 'advanced', query });

      expect(response.statusCode).toBe(200);
      expect(requests).toHaveLength(1);

      return requests[0].query;
    };

    const match = (field: string, value: string, phrase = false) => ({ type: 'match', field, value, phrase });

    const and = (...clauses: object[]) => ({ type: 'and', clauses });
    const or = (...clauses: object[]) => ({ type: 'or', clauses });
    const not = (clause: object) => ({ type: 'not', clause });

    it.each([
      ['a field match', 'name: kangaroo', match('name', 'kangaroo')],
      ['an unquoted value running to the end', 'name: red  kangaroo story', match('name', 'red kangaroo story')],
      ['whitespace around the colon', 'name:kangaroo', match('name', 'kangaroo')],
      ['whitespace before the colon', 'name : kangaroo', match('name', 'kangaroo')],
      ['a quoted phrase', 'name: "red kangaroo"', match('name', 'red kangaroo', true)],
      ['operators in a phrase', 'name: "cats AND dogs"', match('name', 'cats AND dogs', true)],
      ['AND', 'name: a AND inLanguage: eng', and(match('name', 'a'), match('inLanguage', 'eng'))],
      ['OR', 'name: a OR name: b', or(match('name', 'a'), match('name', 'b'))],
      [
        'an unquoted value running to the next operator',
        'name: red fox OR name: b',
        or(match('name', 'red fox'), match('name', 'b')),
      ],
      ['an unquoted value running to a bracket', '(name: red fox)', match('name', 'red fox')],
      ['unary NOT', 'NOT name: a', not(match('name', 'a'))],
      ['AND NOT', 'name: a AND NOT name: b', and(match('name', 'a'), not(match('name', 'b')))],
      ['NOT binding tighter than AND', 'NOT name: a AND name: b', and(not(match('name', 'a')), match('name', 'b'))],
      [
        'AND binding tighter than OR',
        'name: a OR name: b AND name: c',
        or(match('name', 'a'), and(match('name', 'b'), match('name', 'c'))),
      ],
      [
        'brackets',
        '(name: a OR name: b) AND name: c',
        and(or(match('name', 'a'), match('name', 'b')), match('name', 'c')),
      ],
      [
        'a chain of one operator as one node',
        'name: a OR (name: b OR name: c)',
        or(match('name', 'a'), match('name', 'b'), match('name', 'c')),
      ],
      ['a field group', 'name: (a OR "b c")', or(match('name', 'a'), match('name', 'b c', true))],
      [
        'a field group with AND, NOT and brackets',
        'name: (a AND NOT (b OR c d))',
        and(match('name', 'a'), not(or(match('name', 'b'), match('name', 'c d')))),
      ],
      ['lowercase operators as words', 'name: cats and dogs or not', match('name', 'cats and dogs or not')],
      [
        'query syntax from other engines as ordinary characters',
        'name: kang* ?o~2 /re/ [1 TO 2] a^3',
        match('name', 'kang* ?o~2 /re/ [1 TO 2] a^3'),
      ],
      ['a backslash as an ordinary character', 'name: a\\b', match('name', 'a\\b')],
    ])('parses %s', async (_case, query, tree) => {
      expect(await treeFor(query)).toEqual(tree);
    });

    it('passes an empty query as one matching everything', async () => {
      expect(await treeFor('  ')).toEqual({ type: 'all' });
    });

    const rejection = async (payload: object) => {
      const { requests } = await setup({ searchTypes });

      const response = await search(payload);

      expect(response.statusCode).toBe(422);
      expect(requests).toHaveLength(0);
      const { error } = response.json<StandardErrorResponse>();
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details?.violations).toEqual([{ field: 'query', message: error.message }]);

      return error.message;
    };

    it.each([
      [
        'a bare term',
        'kangaroo',
        'Expected ":" after the field name "kangaroo" at position 9, found the end of the query',
      ],
      [
        'a second field in an unquoted value',
        'name: x description: y',
        'Expected AND, OR or the end of the query at position 9, found "description"',
      ],
      ['a missing value', 'name:', 'Expected a value for "name" at position 6, found the end of the query'],
      [
        'a field in a field group',
        'name: (a OR description: b)',
        'Expected a value for "name" at position 13, found "description"',
      ],
      ['a missing operand', 'name: a AND', 'Expected a field name at position 12, found the end of the query'],
      ['a doubled operator', 'name: a OR OR name: b', 'Expected a field name at position 12, found OR'],
      ['a binary NOT', 'name: a NOT name: b', 'Expected AND, OR or the end of the query at position 9, found NOT'],
      ['an unclosed bracket', '(name: a', 'Expected AND, OR or ")" at position 9, found the end of the query'],
      ['an unopened bracket', 'name: a)', 'Expected AND, OR or the end of the query at position 8, found ")"'],
      ['an empty bracket', '()', 'Expected a field name at position 2, found ")"'],
      [
        'a phrase where a field belongs',
        '"kangaroo"',
        'Expected a field name at position 1, found the phrase "kangaroo"',
      ],
      ['a stray colon', ': a', 'Expected a field name at position 1, found ":"'],
      [
        'an unclosed phrase',
        'name: "red kangaroo',
        'Expected a closing " for the phrase at position 7, found the end of the query',
      ],
      [
        'a position counted in code points',
        'name: "🦘" )',
        'Expected AND, OR or the end of the query at position 11, found ")"',
      ],
    ])('rejects %s as a syntax error with a 422', async (_case, query, message) => {
      expect(await rejection({ searchType: 'advanced', query })).toBe(message);
    });

    it.each([
      ['alone', 'secret: zebra', '"secret" at position 1 isn\'t a declared advanced field'],
      ['after a declared one', 'name: a OR secret: zebra', '"secret" at position 12 isn\'t a declared advanced field'],
      ['in another case', 'Name: a', '"Name" at position 1 isn\'t a declared advanced field'],
    ])('rejects an undeclared field %s with a 422 naming it', async (_case, query, message) => {
      expect(await rejection({ searchType: 'advanced', query })).toBe(message);
    });

    const nest = (depth: number): string =>
      depth === 0 ? 'name: b' : `name: a ${depth % 2 ? 'AND' : 'OR'} (${nest(depth - 1)})`;
    const ors = (count: number) => Array.from({ length: count }, (_, n) => `name: w${n}`).join(' OR ');

    it.each([
      ['basic', 'a'.repeat(1025)],
      ['advanced', `name: ${'a'.repeat(1019)}`],
    ])('rejects a %s query over 1024 characters with a 422', async (searchType, query) => {
      expect(await rejection({ searchType, query })).toBe('The query is longer than the limit of 1024 characters');
    });

    it.each([
      ['a basic query of 1024 characters', { query: 'a'.repeat(1024) }],
      ['a query of 1024 code points', { query: '🦘'.repeat(1024) }],
      ['an advanced query of 1024 characters', { searchType: 'advanced', query: `name: ${'a'.repeat(1018)}` }],
      ['10 levels of nesting by NOTs', { searchType: 'advanced', query: `${'NOT '.repeat(10)}name: a` }],
      ['10 levels of nesting by brackets', { searchType: 'advanced', query: nest(10) }],
      ['redundant brackets', { searchType: 'advanced', query: `${'('.repeat(20)}name: a${')'.repeat(20)}` }],
      ['64 clauses', { searchType: 'advanced', query: ors(64) }],
    ])('accepts %s', async (_case, payload) => {
      const { requests } = await setup({ searchTypes });

      const response = await search(payload);

      expect(response.statusCode).toBe(200);
      expect(requests).toHaveLength(1);
    });

    it.each([
      ['NOTs', `${'NOT '.repeat(11)}name: a`],
      ['brackets', nest(11)],
    ])('rejects more than 10 levels of nesting by %s with a 422', async (_case, query) => {
      expect(await rejection({ searchType: 'advanced', query })).toBe(
        'The query nests deeper than the limit of 10 levels',
      );
    });

    it.each([
      ['field matches', ors(65)],
      [
        'values in field groups',
        `name: (${Array.from({ length: 33 }, (_, n) => `w${n}`).join(' OR ')}) AND description: (${Array.from({ length: 32 }, (_, n) => `w${n}`).join(' OR ')})`,
      ],
    ])('rejects more than 64 %s with a 422', async (_case, query) => {
      expect(await rejection({ searchType: 'advanced', query })).toBe(
        'The query has more than the limit of 64 clauses',
      );
    });
  });
});
