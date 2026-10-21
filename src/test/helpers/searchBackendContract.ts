import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchBackend } from '../../search/backend.js';
import type { FieldDeclarations, SearchDocument } from '../../search/fields.js';
import type { SearchVisibilityWhere } from '../../search/visibility.js';
import type { StandardErrorResponse } from '../../utils/errors.js';
import { buildTestApp, createTestEntities } from '../integration.setup.js';

export type SearchBackendContractHarness<Backend extends SearchBackend = SearchBackend> = {
  /** Call the backend's factory */
  create: (fields: FieldDeclarations) => Backend;
  /** Make the backend ready to index, starting from nothing stored */
  prepare: (backend: Backend) => Promise<void>;
};

const fields = {
  name: { type: 'text', weight: 2, sort: true, label: 'Name' },
  description: { type: 'text' },
  inLanguage: { type: 'keyword', facet: true, label: 'Language' },
  open: { type: 'boolean', facet: true },
  pages: { type: 'number', filter: true, sort: true },
  region: { type: 'text', basic: false, facet: { size: 2 } },
  secret: { type: 'keyword' },
} satisfies FieldDeclarations;

const id = (n: number) => `http://example.com/search/${n}`;

const docs: SearchDocument<typeof fields>[] = [
  {
    id: id(1),
    name: 'alpha',
    description: 'A kangaroo story',
    inLanguage: ['eng', 'nys'],
    open: true,
    pages: 10,
    region: 'Central Australia',
  },
  { id: id(2), name: 'bravo', inLanguage: 'eng', open: false, pages: 5, region: 'Central Australia' },
  { id: id(3), name: 'charlie', inLanguage: 'fra', open: true, region: 'Central Australia' },
  { id: id(4), name: 'delta', pages: 20, region: 'Pacific', secret: 'zebra' },
  { id: id(5), name: 'echo', inLanguage: 'eng', open: true, pages: 5, region: 'Arnhem Land' },
];

type SearchBody = {
  total: number;
  entities: { id: string }[];
  facets: Record<string, { name: string; count: number }[]>;
};

/**
 * The `POST /search` and `GET /capabilities` cases every reference search backend must pass
 */
export const describeSearchBackendContract = <Backend extends SearchBackend>(
  name: string,
  harness: SearchBackendContractHarness<Backend>,
) => {
  describe(`${name} search contract`, () => {
    let app: FastifyInstance;

    const load = async (fieldsToDeclare: FieldDeclarations, docsToIndex: SearchDocument[]) => {
      const backend = harness.create(fieldsToDeclare);
      await harness.prepare(backend);
      await createTestEntities(docsToIndex.map((doc) => ({ id: doc.id, name: String(doc.name ?? doc.id) })));
      await backend.index(docsToIndex);
      app = await buildTestApp({ search: backend });
    };

    const search = async (payload: object) => {
      const response = await app.inject({ method: 'POST', url: '/search', payload });
      expect(response.statusCode).toBe(200);

      return response.json<SearchBody>();
    };

    const ids = async (payload: object) => (await search(payload)).entities.map((entity) => entity.id);

    afterEach(async () => {
      await app.close();
    });

    describe('with the shared fields', () => {
      beforeEach(async () => {
        await load(fields, docs);
      });

      it('publishes capabilities derived from the declarations', async () => {
        const response = await app.inject({ method: 'GET', url: '/capabilities' });

        expect(response.json().search).toEqual({
          filters: {
            inLanguage: { type: 'string', label: 'Language' },
            open: { type: 'boolean' },
            pages: { type: 'number' },
            region: { type: 'string' },
          },
          facets: { inLanguage: { label: 'Language' }, open: {}, region: {} },
          sorts: { name: { label: 'Name' }, pages: {} },
          searchTypes: { basic: {} },
          geo: { supported: false },
        });
      });

      it('matches every entity for an empty query, with an exact total', async () => {
        const body = await search({ query: '' });

        expect(body.total).toBe(5);
        expect(body.entities.map((entity) => entity.id).sort()).toEqual([id(1), id(2), id(3), id(4), id(5)]);
      });

      it('keeps relevance order stable across pages for an empty query', async () => {
        const all = await ids({ query: '' });
        const paged = [
          ...(await ids({ query: '', limit: 2, offset: 0 })),
          ...(await ids({ query: '', limit: 2, offset: 2 })),
          ...(await ids({ query: '', limit: 2, offset: 4 })),
        ];

        expect(paged).toEqual(all);
      });

      it.each(['*', '!!!'])('matches every entity for a query with no searchable words: %s', async (query) => {
        const body = await search({ query });

        expect(body.total).toBe(5);
        expect(body.entities.map((entity) => entity.id).sort()).toEqual([id(1), id(2), id(3), id(4), id(5)]);
      });

      it('finds a word in a basic text field', async () => {
        expect(await ids({ query: 'kangaroo' })).toContain(id(1));
      });

      it.each([
        ['a text field that opted out of basic search', 'Pacific'],
        ['a field with no role', 'zebra'],
      ])('does not search %s', async (_field, query) => {
        expect(await ids({ query })).not.toContain(id(4));
      });

      it.each([
        ['a keyword', { inLanguage: ['eng'] }, [1, 2, 5]],
        ['any of several values', { inLanguage: ['nys', 'fra'] }, [1, 3]],
        ['a boolean', { open: ['true'] }, [1, 3, 5]],
        ['a number', { pages: ['5'] }, [2, 5]],
        ["a text field's exact form", { region: ['Central Australia'] }, [1, 2, 3]],
        ["a text field's exact form, not its words", { region: ['central'] }, []],
        ['several fields, all of which must match', { inLanguage: ['eng'], open: ['true'] }, [1, 5]],
      ])('filters by %s', async (_filter, filters, expected) => {
        const body = await search({ query: '', filters });

        expect(body.total).toBe(expected.length);
        expect(body.entities.map((entity) => entity.id).sort()).toEqual(expected.map(id));
      });

      it('names facet buckets by value and orders them by count, then name, up to the facet size', async () => {
        const { facets } = await search({ query: '' });

        expect(facets).toEqual({
          inLanguage: [
            { name: 'eng', count: 3 },
            { name: 'fra', count: 1 },
            { name: 'nys', count: 1 },
          ],
          open: [
            { name: 'true', count: 3 },
            { name: 'false', count: 1 },
          ],
          region: [
            { name: 'Central Australia', count: 3 },
            { name: 'Arnhem Land', count: 1 },
          ],
        });
      });

      it('counts facets over the filtered hits', async () => {
        const { facets } = await search({ query: '', filters: { open: ['true'] } });

        expect(facets.inLanguage).toEqual([
          { name: 'eng', count: 2 },
          { name: 'fra', count: 1 },
          { name: 'nys', count: 1 },
        ]);
      });

      it('includes every declared facet, empty, when nothing matches', async () => {
        const body = await search({ query: '', filters: { inLanguage: ['none'] } });

        expect(body.total).toBe(0);
        expect(body.facets).toEqual({ inLanguage: [], open: [], region: [] });
      });

      it.each([
        ['name', 'asc', [1, 2, 3, 4, 5]],
        ['name', 'desc', [5, 4, 3, 2, 1]],
        ['pages', 'asc', [2, 5, 1, 4, 3]],
        ['pages', 'desc', [4, 1, 2, 5, 3]],
      ])('sorts by %s %s, ties by id and missing values last', async (sort, order, expected) => {
        expect(await ids({ query: '', sort, order })).toEqual(expected.map(id));
      });

      it('pages through a sort', async () => {
        expect(await ids({ query: '', sort: 'name', limit: 2, offset: 2 })).toEqual([id(3), id(4)]);
      });

      it.each([
        ['an undeclared filter key', { filters: { secret: ['zebra'] } }],
        ['an undeclared sort', { sort: 'description' }],
        ['an undeclared search type', { searchType: 'advanced' }],
        ['a boolean filter value other than true or false', { filters: { open: ['yes'] } }],
      ])('rejects %s with a 400', async (_problem, payload) => {
        const response = await app.inject({ method: 'POST', url: '/search', payload: { query: '', ...payload } });

        expect(response.statusCode).toBe(400);
        expect(response.json<StandardErrorResponse>().error.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('with dates, numbers and geo', () => {
      const geoFields = {
        name: { type: 'text', sort: true },
        datePublished: { type: 'date', facet: true },
        pages: { type: 'number', filter: true },
        inLanguage: { type: 'keyword', filter: true },
        open: { type: 'boolean', filter: true },
        location: { type: 'geo' },
      } satisfies FieldDeclarations;

      const geoDocs: SearchDocument<typeof geoFields>[] = [
        { id: id(1), name: 'sydney', datePublished: '2001', pages: 10, location: { lat: -33.87, lng: 151.21 } },
        {
          id: id(2),
          name: 'darwin',
          datePublished: '2001-12-31T23:30:00-01:00',
          pages: 5,
          location: { lat: -12.46, lng: 130.84 },
        },
        { id: id(3), name: 'suva', datePublished: '1999-06', pages: 1, location: { lat: -18.14, lng: 178.44 } },
        {
          id: id(4),
          name: 'apia',
          datePublished: ['1999-01-01', '2003-05-05'],
          location: { lat: -13.83, lng: -171.76 },
        },
        { id: id(5), name: 'nowhere', pages: 20 },
      ];

      const sortedIds = async (payload: object) => (await ids({ query: '', ...payload })).sort();

      beforeEach(async () => {
        await load(geoFields, geoDocs);
      });

      it('publishes geo as supported when a geo field is declared', async () => {
        const response = await app.inject({ method: 'GET', url: '/capabilities' });

        expect(response.json().search).toMatchObject({
          filters: { datePublished: { type: 'date' }, pages: { type: 'number' } },
          geo: { supported: true },
        });
      });

      it.each([
        ['a whole year, matching a partial date', { datePublished: { gte: '2001-01-01', lte: '2001-12-31' } }, [1]],
        [
          'any of several years',
          {
            datePublished: [
              { gte: '2001-01-01', lte: '2001-12-31' },
              { gte: '1999-01-01', lte: '1999-12-31' },
            ],
          },
          [1, 3, 4],
        ],
        ['a date-time bound, in UTC', { datePublished: { gte: '2002-01-01T00:00:00Z' } }, [2, 4]],
        ['a date-time bound with an offset', { datePublished: { lte: '2002-01-01T10:00:00+10:00' } }, [1, 3, 4]],
        ['an exact date, covering its UTC day', { datePublished: ['2002-01-01'] }, [2]],
        ['a number range', { pages: { gte: 5, lte: 10 } }, [1, 2]],
        ['an open-ended number range', { pages: { gte: 10 } }, [1, 5]],
        ['any of several number ranges', { pages: [{ lte: 1 }, { gte: 20 }] }, [3, 5]],
        ['an exact number', { pages: ['5'] }, [2]],
      ])('filters by %s', async (_filter, filters, expected) => {
        expect(await sortedIds({ filters })).toEqual(expected.map(id));
      });

      it('buckets a date facet by UTC year, named YYYY and ordered by year', async () => {
        const { facets } = await search({ query: '' });

        expect(facets.datePublished).toEqual([
          { name: '1999', count: 2 },
          { name: '2001', count: 1 },
          { name: '2002', count: 1 },
          { name: '2003', count: 1 },
        ]);
      });

      it('counts date buckets over the filtered hits', async () => {
        const { facets } = await search({ query: '', filters: { pages: { lte: 5 } } });

        expect(facets.datePublished).toEqual([
          { name: '1999', count: 1 },
          { name: '2002', count: 1 },
        ]);
      });

      it('filters by a bounding box', async () => {
        const boundingBox = { topRight: { lat: -10, lng: 155 }, bottomLeft: { lat: -45, lng: 110 } };

        expect(await sortedIds({ boundingBox })).toEqual([id(1), id(2)]);
      });

      it('filters by a bounding box crossing the antimeridian', async () => {
        const boundingBox = { topRight: { lat: 0, lng: -170 }, bottomLeft: { lat: -20, lng: 170 } };

        expect(await sortedIds({ boundingBox })).toEqual([id(3), id(4)]);
      });

      it('counts the hits in the box per geohash cell', async () => {
        const boundingBox = { topRight: { lat: 0, lng: 180 }, bottomLeft: { lat: -45, lng: 110 } };
        const response = await app.inject({
          method: 'POST',
          url: '/search',
          payload: { query: '', boundingBox, geohashPrecision: 2, filters: { pages: { gte: 1 } } },
        });

        expect(response.json().geohashGrid).toEqual({ r3: 1, qv: 1, ru: 1 });
      });

      it('gives an empty geohash grid when nothing in the box matches', async () => {
        const boundingBox = { topRight: { lat: 60, lng: 10 }, bottomLeft: { lat: 40, lng: -10 } };
        const response = await app.inject({
          method: 'POST',
          url: '/search',
          payload: { query: '', boundingBox, geohashPrecision: 3 },
        });

        expect(response.json()).toMatchObject({ total: 0, geohashGrid: {} });
      });

      it.each([
        ['a range on a string filter', { filters: { inLanguage: { gte: 'a' } } }],
        ['a range on a boolean filter', { filters: { open: [{ gte: 'false' }] } }],
        ['a partial date as a range bound', { filters: { datePublished: { gte: '2001' } } }],
        ['a range with gte above lte', { filters: { pages: { gte: 10, lte: 5 } } }],
        ['a geohash precision without a bounding box', { geohashPrecision: 2 }],
      ])('rejects %s with a 400', async (_problem, payload) => {
        const response = await app.inject({ method: 'POST', url: '/search', payload: { query: '', ...payload } });

        expect(response.statusCode).toBe(400);
        expect(response.json<StandardErrorResponse>().error.code).toBe('VALIDATION_ERROR');
      });
    });

    it.each([
      ['a bounding box', { boundingBox: { topRight: { lat: 0, lng: 1 }, bottomLeft: { lat: -1, lng: 0 } } }],
      ['a geohash precision', { geohashPrecision: 2 }],
    ])('rejects %s with a 400 when no geo field is declared', async (_param, payload) => {
      await load(fields, docs);

      const response = await app.inject({ method: 'POST', url: '/search', payload: { query: '', ...payload } });

      expect(response.statusCode).toBe(400);
      expect(response.json<StandardErrorResponse>().error.code).toBe('VALIDATION_ERROR');
    });

    describe('advanced queries', () => {
      const advancedFields = {
        name: { type: 'text', advanced: true, label: 'Name' },
        description: { type: 'text', advanced: true },
        inLanguage: { type: 'keyword', advanced: true, filter: true },
        pages: { type: 'number', advanced: true },
        open: { type: 'boolean', advanced: true },
        secret: { type: 'text' },
      } satisfies FieldDeclarations;

      const advancedDocs: SearchDocument<typeof advancedFields>[] = [
        {
          id: id(1),
          name: 'red kangaroo',
          description: 'A story of a kangaroo that was red',
          inLanguage: ['eng', 'nys'],
          pages: 10,
          open: true,
        },
        {
          id: id(2),
          name: 'kangaroo red',
          description: 'A red bird and a grey kangaroo',
          inLanguage: 'eng',
          pages: 5,
          open: false,
        },
        { id: id(3), name: 'grey kangaroo', description: 'Nothing red here', inLanguage: 'fra', open: true },
        { id: id(4), name: 'wombat', description: 'A wombat burrow', pages: 20, secret: 'kangaroo' },
        { id: id(5), name: 'echidna', inLanguage: 'english', open: true },
      ];

      beforeEach(async () => {
        await load(advancedFields, advancedDocs);
      });

      const advanced = async (query: string, filters?: object) => {
        const body = await search({ searchType: 'advanced', query, ...(filters && { filters }) });

        expect(body.total).toBe(body.entities.length);

        return body.entities.map((entity) => entity.id).sort();
      };

      it('publishes the advanced fields in capabilities', async () => {
        const response = await app.inject({ method: 'GET', url: '/capabilities' });

        expect(response.json().search.searchTypes).toEqual({
          basic: {},
          advanced: { fields: { name: { label: 'Name' }, description: {}, inLanguage: {}, pages: {}, open: {} } },
        });
      });

      it.each([
        ['an empty query, matching everything', '', [1, 2, 3, 4, 5]],
        ['a word', 'name: kangaroo', [1, 2, 3]],
        ['all the words, in any order', 'name: red kangaroo', [1, 2]],
        ['an exact phrase', 'name: "red kangaroo"', [1]],
        ['a phrase within longer text', 'description: "red bird"', [2]],
        ['a keyword exactly', 'inLanguage: eng', [1, 2]],
        ['a keyword exactly, not its prefix', 'inLanguage: en', []],
        ['a number exactly', 'pages: 10', [1]],
        ['a boolean exactly', 'open: false', [2]],
        ['AND', 'name: kangaroo AND inLanguage: eng', [1, 2]],
        ['OR', 'name: wombat OR name: echidna', [4, 5]],
        ['NOT alone', 'NOT name: kangaroo', [4, 5]],
        ['AND NOT', 'name: kangaroo AND NOT description: grey', [1, 3]],
        ['a field group', 'name: (wombat OR echidna)', [4, 5]],
        ['a field group with NOT', 'name: (kangaroo AND NOT grey)', [1, 2]],
        ['NOT before AND', 'NOT name: kangaroo AND description: wombat', [4]],
        ['AND before OR', 'name: echidna OR name: kangaroo AND inLanguage: fra', [3, 5]],
        ['brackets over precedence', '(name: echidna OR name: kangaroo) AND inLanguage: fra', [3]],
      ])('matches %s', async (_case, query, expected) => {
        expect(await advanced(query)).toEqual(expected.map(id));
      });

      it('applies filters to an advanced query', async () => {
        expect(await advanced('name: kangaroo', { inLanguage: ['fra'] })).toEqual([id(3)]);
      });

      it.each([
        ['an undeclared field', 'secret: kangaroo'],
        ['a syntax error', 'name: (kangaroo'],
      ])('rejects %s with a 422', async (_problem, query) => {
        const response = await app.inject({
          method: 'POST',
          url: '/search',
          payload: { searchType: 'advanced', query },
        });

        expect(response.statusCode).toBe(422);
        expect(response.json<StandardErrorResponse>().error.details?.violations).toEqual([
          { field: 'query', message: expect.any(String) },
        ]);
      });

      const ors = (count: number) =>
        ['name: wombat', ...Array.from({ length: count - 1 }, (_, n) => `name: w${n}`)].join(' OR ');

      it.each([
        ['1024 code points', `name: wombat OR name: ${'🦘'.repeat(1002)}`, [4]],
        ['10 levels of nesting', `${'NOT '.repeat(10)}name: wombat`, [4]],
        ['64 clauses', ors(64), [4]],
      ])('runs a query at the cap of %s', async (_cap, query, expected) => {
        expect(await advanced(query)).toEqual(expected.map(id));
      });

      it.each([
        ['1024 code points', `name: wombat OR name: ${'🦘'.repeat(1003)}`],
        ['10 levels of nesting', `${'NOT '.repeat(11)}name: wombat`],
        ['64 clauses', ors(65)],
      ])('rejects a query over the cap of %s with a 422', async (_cap, query) => {
        const response = await app.inject({
          method: 'POST',
          url: '/search',
          payload: { searchType: 'advanced', query },
        });

        expect(response.statusCode).toBe(422);
        expect(response.json<StandardErrorResponse>().error.code).toBe('VALIDATION_ERROR');
      });

      it('ranks entities matching more of the query first, stable across pages', async () => {
        const query = 'name: kangaroo OR description: kangaroo';
        const all = await ids({ searchType: 'advanced', query });
        const pages = await Promise.all(
          [0, 1, 2].map((offset) => ids({ searchType: 'advanced', query, limit: 1, offset })),
        );

        expect(all.slice(0, 2).sort()).toEqual([id(1), id(2)]);
        expect(all[2]).toBe(id(3));
        expect(pages.flat()).toEqual(all);
      });
    });

    it('gives an exact total above 10,000 hits', { timeout: 60_000 }, async () => {
      const many = Array.from({ length: 10_001 }, (_, n) => ({ id: id(n), name: 'many' }));
      await load({ name: { type: 'text' } }, many);

      const body = await search({ query: '', limit: 1 });

      expect(body.total).toBe(10_001);
    });

    describe('search visibility', () => {
      const visibilityFields = {
        title: { type: 'text', basic: false },
        tags: { type: 'keyword', facet: true },
        draft: { type: 'boolean' },
        pages: { type: 'number' },
        created: { type: 'date' },
        location: { type: 'geo' },
      } satisfies FieldDeclarations;

      const visibilityDocs: SearchDocument<typeof visibilityFields>[] = [
        { id: id(1), title: 'Hello World', tags: ['a', 'b'], draft: true, pages: 10, created: '2001' },
        { id: id(2), tags: 'b', draft: false, pages: 5, created: '2010-06-01' },
        { id: id(3) },
        { id: id(4), tags: ['c'], pages: 20, created: '2020-01-01T10:00:00+10:00' },
      ];

      const loadVisible = async (where: unknown) => {
        const backend = harness.create(visibilityFields);
        await harness.prepare(backend);
        await createTestEntities(visibilityDocs.map((doc) => ({ id: doc.id, name: doc.id })));
        await backend.index(visibilityDocs);
        app = await buildTestApp({ search: backend, searchVisibilityFilter: () => where as SearchVisibilityWhere });
      };

      it.each<[string, SearchVisibilityWhere<typeof visibilityFields>, number[]]>([
        ['everything for {}', {}, [1, 2, 3, 4]],
        ['a bare value as equals', { draft: true }, [1]],
        ['a null-prototype object', Object.assign(Object.create(null), { draft: true }), [1]],
        ['not, including entities missing the field', { draft: { not: true } }, [2, 3, 4]],
        ['null to entities missing the field', { draft: null }, [3, 4]],
        ['equals null to entities missing the field', { draft: { equals: null } }, [3, 4]],
        ['not null to entities with the field', { draft: { not: null } }, [1, 2]],
        ['equals to any of several values', { tags: { equals: 'b' } }, [1, 2]],
        ['not to entities where no value matches', { tags: { not: 'b' } }, [3, 4]],
        ['in to any of several values', { tags: { in: ['a', 'c'] } }, [1, 4]],
        ['an empty in', { tags: { in: [] } }, []],
        ['notIn to entities where no value is listed', { tags: { notIn: ['a'] } }, [2, 3, 4]],
        ['an empty notIn', { tags: { notIn: [] } }, [1, 2, 3, 4]],
        ["a text field's exact form", { title: 'Hello World' }, [1]],
        ["a text field's exact form, not its words", { title: 'Hello' }, []],
        ['a number range', { pages: { gt: 5, lte: 20 } }, [1, 4]],
        ['a number bound, leaving out entities missing the field', { pages: { lt: 10 } }, [2]],
        ['a partial date bound as its first UTC instant', { created: { gte: '2010' } }, [2, 4]],
        ['a Date bound', { created: { lt: new Date('2010-06-01T00:00:00Z') } }, [1]],
        ['a date in UTC', { created: '2020-01-01' }, [4]],
        ['a number with equality and a bound together', { pages: { not: 10, gte: 5 } }, [2, 4]],
        ['id', { id: id(2) }, [2]],
        ['notIn on id', { id: { notIn: [id(1), id(2)] } }, [3, 4]],
        ['null on id to no entities', { id: null }, []],
        ['several keys as AND', { tags: 'b', pages: 5 }, [2]],
        ['AND', { AND: [{ tags: 'b' }, { draft: { not: true } }] }, [2]],
        ['OR', { OR: [{ draft: true }, { pages: 20 }] }, [1, 4]],
        ['an empty OR', { OR: [] }, []],
        ['NOT, matching none of its filters', { NOT: [{ draft: true }, { pages: 20 }] }, [2, 3]],
        ['undefined as no condition', { draft: undefined, pages: { gte: undefined, lt: 10 } }, [2]],
      ])('applies %s to hits and total', async (_case, where, expected) => {
        await loadVisible(where);

        const body = await search({ query: '' });

        expect(body.total).toBe(expected.length);
        expect(body.entities.map((entity) => entity.id).sort()).toEqual(expected.map(id));
      });

      it('counts facets over visible entities only', async () => {
        await loadVisible({ draft: { not: true } });

        const { facets } = await search({ query: '' });

        expect(facets.tags).toEqual([
          { name: 'b', count: 1 },
          { name: 'c', count: 1 },
        ]);
      });

      it.each([
        ['an undeclared field', { secret: 'x' }, 'secret'],
        ['a geo field', { location: null }, 'location'],
        ['a range on a keyword', { tags: { lt: 'b' } }, 'tags'],
        ['an unknown operator', { pages: { contains: 5 } }, 'pages'],
        ['a value of the wrong type', { AND: [{ pages: 'ten' }] }, 'pages'],
        ['a bad date', { created: { gte: '2001-13' } }, 'created'],
        ['a date that is neither a string nor a Date', { created: 2001 }, 'created'],
        ['an invalid Date', { created: new Date('never') }, 'created'],
        ['a keyword that is not a string', { tags: { in: [5] } }, 'tags'],
        ['a boolean that is not a boolean', { draft: { not: 'yes' } }, 'draft'],
        ['in without an array', { tags: { in: 'a' } }, 'tags'],
        ['a combinator without an array', { OR: { draft: true } }, 'OR'],
        ['a filter that is not an object', 'draft', 'filter'],
        ['a filter that is a Map', new Map([['draft', true]]), 'filter'],
        ['a nested filter that is a class instance', { AND: [new URL('https://example.org')] }, 'AND[0]'],
        ['a field condition that is a Map', { draft: new Map([['not', true]]) }, 'draft'],
      ])('answers a filter with %s with a 500, logging the field', async (_case, where, field) => {
        await loadVisible(where);
        const logError = vi.spyOn(app.log, 'error');

        const response = await app.inject({ method: 'POST', url: '/search', payload: { query: '' } });

        expect(response.statusCode).toBe(500);
        expect(response.json<StandardErrorResponse>().error.code).toBe('INTERNAL_ERROR');
        expect(logError).toHaveBeenCalledWith({
          err: expect.objectContaining({ message: expect.stringContaining(`"${field}"`) }),
        });
      });
    });

    describe('advanced query values', () => {
      const valueFields = {
        pages: { type: 'number', advanced: true },
        open: { type: 'boolean', advanced: true },
        created: { type: 'date', advanced: true },
      } satisfies FieldDeclarations;

      const valueDocs: SearchDocument<typeof valueFields>[] = [
        { id: id(1), pages: 10, open: true, created: '2001' },
        { id: id(2), pages: 2.5, open: false, created: '2010-06-01T10:00:00+10:00' },
        { id: id(3), created: '2001-06-15' },
      ];

      beforeEach(async () => {
        await load(valueFields, valueDocs);
      });

      it.each([
        ['a decimal number', 'pages: 2.5', [2]],
        ['a date with an offset as its UTC instant', 'created: "2010-06-01T00:00:00Z"', [2]],
      ])('matches %s exactly', async (_case, query, expected) => {
        expect(await ids({ searchType: 'advanced', query })).toEqual(expected.map(id));
      });

      it.each([
        ['a year', 'created: 2001', [1, 3]],
        ['a month', 'created: 2001-06', [3]],
        ['a day', 'created: 2010-06-01', [2]],
        ['a day with no match', 'created: 2001-06-14', []],
      ])('matches a date in the whole of %s', async (_case, query, expected) => {
        expect((await ids({ searchType: 'advanced', query })).sort()).toEqual(expected.map(id));
      });

      it.each([
        ['a number field', 'pages: abc'],
        ['a number field, out of range', 'pages: 1e999'],
        ['a boolean field', 'open: yes'],
        ['a date field', 'created: abc'],
      ])("rejects a value %s can't hold with a 422", async (_field, query) => {
        const response = await app.inject({
          method: 'POST',
          url: '/search',
          payload: { searchType: 'advanced', query },
        });

        expect(response.statusCode).toBe(422);
        expect(response.json<StandardErrorResponse>().error.code).toBe('VALIDATION_ERROR');
      });
    });
  });
};
