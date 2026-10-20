import { beforeEach, describe, expect, it } from 'vitest';
import type { FieldDeclarations } from '../../search/fields.js';

type WriteBackend = {
  index(docs: Record<string, unknown>[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
};

export type SearchBackendWriteHarness<Backend extends WriteBackend = WriteBackend> = {
  /** Call the backend's factory */
  create: (fields: FieldDeclarations) => Backend;
  /** Make the backend ready to index, starting from nothing stored */
  prepare: (backend: Backend) => Promise<void>;
  /** The stored search document, with dates as `toISOString()` strings, or undefined if there is none */
  read: (id: string) => Promise<Record<string, unknown> | undefined>;
};

const fields = {
  name: { type: 'text', sort: true },
  description: { type: 'text' },
  inLanguage: { type: 'keyword', facet: true },
  originatedOn: { type: 'date', filter: true },
  pages: { type: 'number' },
  draft: { type: 'boolean' },
  location: { type: 'geo' },
} satisfies FieldDeclarations;

/**
 * The write-surface cases every reference search backend must pass
 */
export const describeSearchBackendWrites = <Backend extends WriteBackend>(
  name: string,
  harness: SearchBackendWriteHarness<Backend>,
) => {
  describe(`${name} write surface`, () => {
    describe('field declarations', () => {
      it.each(['1st', 'has-dash', 'has space', 'dotted.name', ''])('rejects the field name %j', (fieldName) => {
        expect(() => harness.create({ [fieldName]: { type: 'keyword' } })).toThrow(fieldName);
      });

      it('accepts a name with letters, digits and underscores', () => {
        expect(() => harness.create({ _Field_2: { type: 'keyword' } })).not.toThrow();
      });

      it('reserves id', () => {
        expect(() => harness.create({ id: { type: 'keyword' } })).toThrow('"id" is reserved');
      });

      it('rejects relevance as a sort field', () => {
        expect(() => harness.create({ relevance: { type: 'keyword', sort: true } })).toThrow('"relevance"');
      });

      it('allows a field named relevance that is not a sort', () => {
        expect(() => harness.create({ relevance: { type: 'keyword', filter: true } })).not.toThrow();
      });

      it('rejects more than one geo field', () => {
        expect(() => harness.create({ location: { type: 'geo' }, origin: { type: 'geo' } })).toThrow('"origin"');
      });

      it.each([0, 5, 1.5, -1])('rejects the weight %j', (weight) => {
        expect(() => harness.create({ title: { type: 'text', weight } })).toThrow('"title"');
      });

      it.each([1, 4])('accepts the weight %j', (weight) => {
        expect(() => harness.create({ title: { type: 'text', weight } })).not.toThrow();
      });

      it('rejects a weight on a field that is not text', () => {
        expect(() => harness.create({ code: { type: 'keyword', weight: 2 } })).toThrow('"code"');
      });

      it.each([0, -1, 2.5])('rejects the facet size %j', (size) => {
        expect(() => harness.create({ language: { type: 'keyword', facet: { size } } })).toThrow('"language"');
      });

      it('accepts a large facet size', () => {
        expect(() => harness.create({ language: { type: 'keyword', facet: { size: 5000 } } })).not.toThrow();
      });

      it('rejects an unknown type', () => {
        expect(() => harness.create({ title: { type: 'string' as 'text' } })).toThrow('"title"');
      });

      it.each(['basic', 'advanced', 'filter', 'facet', 'sort'] as const)(
        'rejects the %s role on a geo field',
        (role) => {
          expect(() => harness.create({ location: { type: 'geo', [role]: true } })).toThrow('"location"');
        },
      );

      it('rejects a facet on a number field', () => {
        expect(() => harness.create({ pages: { type: 'number', facet: true } })).toThrow('"pages"');
      });

      it.each(['date', 'number', 'boolean'] as const)('rejects basic search on a %s field', (type) => {
        expect(() => harness.create({ value: { type, basic: true } })).toThrow('"value"');
      });
    });

    describe('index and remove', () => {
      let backend: Backend;

      beforeEach(async () => {
        backend = harness.create(fields);
        await harness.prepare(backend);
      });

      it('stores a search document', async () => {
        await backend.index([
          {
            id: 'http://example.com/1',
            name: 'Greeting',
            description: ['A greeting', 'In Nyeleni'],
            inLanguage: ['eng', 'nys'],
            originatedOn: '2001-02-03T04:05:06Z',
            pages: 12.5,
            draft: false,
            location: { lat: -33.87, lng: 151.21 },
          },
        ]);

        expect(await harness.read('http://example.com/1')).toEqual({
          id: 'http://example.com/1',
          name: 'Greeting',
          description: ['A greeting', 'In Nyeleni'],
          inLanguage: ['eng', 'nys'],
          originatedOn: '2001-02-03T04:05:06.000Z',
          pages: 12.5,
          draft: false,
          location: { lat: -33.87, lng: 151.21 },
        });
      });

      it('allows missing fields', async () => {
        await backend.index([{ id: 'http://example.com/1' }]);

        expect(await harness.read('http://example.com/1')).toEqual({ id: 'http://example.com/1' });
      });

      it('replaces a search document indexed again, so reloading is safe', async () => {
        const doc = { id: 'http://example.com/1', name: 'Greeting', inLanguage: 'eng' };
        await backend.index([doc]);
        await backend.index([doc]);
        expect(await harness.read('http://example.com/1')).toEqual(doc);

        await backend.index([{ id: 'http://example.com/1', name: 'Hello' }]);
        expect(await harness.read('http://example.com/1')).toEqual({ id: 'http://example.com/1', name: 'Hello' });
      });

      it('indexes a batch', async () => {
        await backend.index([
          { id: 'http://example.com/1', name: 'One' },
          { id: 'http://example.com/2', name: 'Two' },
        ]);

        expect(await harness.read('http://example.com/1')).toEqual({ id: 'http://example.com/1', name: 'One' });
        expect(await harness.read('http://example.com/2')).toEqual({ id: 'http://example.com/2', name: 'Two' });
      });

      it('does nothing for an empty batch', async () => {
        await expect(backend.index([])).resolves.toBeUndefined();
        await expect(backend.remove([])).resolves.toBeUndefined();
      });

      it('removes search documents idempotently', async () => {
        await backend.index([
          { id: 'http://example.com/1', name: 'One' },
          { id: 'http://example.com/2', name: 'Two' },
        ]);

        await backend.remove(['http://example.com/1', 'http://example.com/never-indexed']);
        await backend.remove(['http://example.com/1']);

        expect(await harness.read('http://example.com/1')).toBeUndefined();
        expect(await harness.read('http://example.com/2')).toEqual({ id: 'http://example.com/2', name: 'Two' });
      });

      it.each([
        ['2001', '2001-01-01T00:00:00.000Z'],
        ['2001-02', '2001-02-01T00:00:00.000Z'],
        ['2001-02-03', '2001-02-03T00:00:00.000Z'],
        ['2001-02-03T04:05:06', '2001-02-03T04:05:06.000Z'],
        ['2001-02-03 04:05:06.789', '2001-02-03T04:05:06.789Z'],
        ['2001-02-03t04:05:06z', '2001-02-03T04:05:06.000Z'],
        ['2001-02-03T04:05:06.1+10:00', '2001-02-02T18:05:06.100Z'],
        ['2001-02-03T20:05:06-05:30', '2001-02-04T01:35:06.000Z'],
        ['0099-12-31', '0099-12-31T00:00:00.000Z'],
        ['2000-02-29', '2000-02-29T00:00:00.000Z'],
      ])('stores the date %j as its first UTC instant', async (originatedOn, stored) => {
        await backend.index([{ id: 'http://example.com/1', originatedOn: [originatedOn] }]);

        expect(await harness.read('http://example.com/1')).toEqual({
          id: 'http://example.com/1',
          originatedOn: [stored],
        });
      });

      it.each([
        ['an undeclared key', { title: 'Greeting' }, 'title'],
        ['text that is not a string', { name: 42 }, 'name'],
        ['a keyword that is not a string', { inLanguage: ['eng', 1] }, 'inLanguage'],
        ['a number that is not a number', { pages: '12' }, 'pages'],
        ['a number that is not finite', { pages: Number.NaN }, 'pages'],
        ['a boolean that is not a boolean', { draft: 'false' }, 'draft'],
        ['a null value', { name: null }, 'name'],
        ['a date that is not a string', { originatedOn: 2001 }, 'originatedOn'],
        ['an unparseable date', { originatedOn: 'last Tuesday' }, 'originatedOn'],
        ['a date with a bad month', { originatedOn: '2001-13' }, 'originatedOn'],
        ['a date with a bad day', { originatedOn: '2001-02-29' }, 'originatedOn'],
        ['a date-time with a bad hour', { originatedOn: '2001-02-03T24:00:00Z' }, 'originatedOn'],
        ['a date-time with a bad offset', { originatedOn: '2001-02-03T04:05:06+25:00' }, 'originatedOn'],
        ['a latitude out of range', { location: { lat: 91, lng: 0 } }, 'location'],
        ['a longitude out of range', { location: { lat: 0, lng: -181 } }, 'location'],
        ['coordinates that are not numbers', { location: { lat: '1', lng: 2 } }, 'location'],
        ['coordinates with an extra key', { location: { lat: 1, lng: 2, alt: 3 } }, 'location'],
        ['coordinates that are not an object', { location: 'here' }, 'location'],
        ['several points', { location: [{ lat: 1, lng: 2 }] }, 'location'],
        ['an array in a sort field', { name: ['Greeting'] }, 'name'],
      ])('throws on %s, naming the entity and key', async (_problem, values, key) => {
        await expect(backend.index([{ id: 'http://example.com/bad', ...values }])).rejects.toThrow(
          new RegExp(`"http://example\\.com/bad".*"${key}"`),
        );
      });

      it('throws on a search document without an id', async () => {
        await expect(backend.index([{ name: 'Greeting' }])).rejects.toThrow('id');
        await expect(backend.index([{ id: '' }])).rejects.toThrow('id');
      });

      it('stores nothing from a batch with a bad search document', async () => {
        await expect(
          backend.index([
            { id: 'http://example.com/1', name: 'Good' },
            { id: 'http://example.com/2', pages: 'bad' },
          ]),
        ).rejects.toThrow('"http://example.com/2"');

        expect(await harness.read('http://example.com/1')).toBeUndefined();
      });
    });
  });
};
