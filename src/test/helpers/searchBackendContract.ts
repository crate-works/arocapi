import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchBackend } from '../../search/backend.js';
import type { FieldDeclarations, SearchDocument } from '../../search/fields.js';
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

    it('gives an exact total above 10,000 hits', { timeout: 60_000 }, async () => {
      const many = Array.from({ length: 10_001 }, (_, n) => ({ id: id(n), name: 'many' }));
      await load({ name: { type: 'text' } }, many);

      const body = await search({ query: '', limit: 1 });

      expect(body.total).toBe(10_001);
    });
  });
};
