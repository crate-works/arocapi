import { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeSearchBackendWrites } from '../test/helpers/searchBackendWrite.js';
import type { FieldDeclarations } from './fields.js';
import { OpenSearchBackend } from './opensearch.js';

const client = new Client({ node: 'http://localhost:9201' });
const indexName = 'search-backend-write-test';

const fromGeoPoint = (point: unknown) => {
  const { lat, lon } = point as { lat: number; lon: number };

  return { lat, lng: lon };
};

const dropIndex = () => client.indices.delete({ index: indexName, ignore_unavailable: true });

afterAll(async () => {
  await dropIndex();
  await client.close();
});

describeSearchBackendWrites('OpenSearchBackend', {
  create: (fields) => OpenSearchBackend({ client, fields, indexName }),
  prepare: async (backend) => {
    await dropIndex();
    await backend.createIndex();
  },
  read: async (id) => {
    const { body } = await client.get({ index: indexName, id }, { ignore: [404] });

    if (!body.found) {
      return undefined;
    }
    const { location, ...source } = body._source as Record<string, unknown>;

    return location ? { ...source, location: fromGeoPoint(location) } : source;
  },
});

describe('OpenSearchBackend', () => {
  beforeEach(dropIndex);

  const fields = {
    name: { type: 'text' },
    inLanguage: { type: 'keyword', facet: true },
  } satisfies FieldDeclarations;

  describe('createIndex', () => {
    it('leaves an index created from the same declarations alone', async () => {
      await OpenSearchBackend({ client, fields, indexName }).createIndex();
      await OpenSearchBackend({ client, fields, indexName }).index([{ id: 'http://example.com/1', name: 'One' }]);

      await expect(OpenSearchBackend({ client, fields, indexName }).createIndex()).resolves.toBeUndefined();
      const { body } = await client.count({ index: indexName });
      expect(body.count).toBe(1);
    });

    it('throws, naming the field, when a declaration changed', async () => {
      await OpenSearchBackend({ client, fields, indexName }).createIndex();

      const changed = OpenSearchBackend({
        client,
        fields: { ...fields, name: { type: 'text', sort: true } },
        indexName,
      });

      await expect(changed.createIndex()).rejects.toThrow(`Index "${indexName}"`);
      await expect(changed.createIndex()).rejects.toThrow('"name"');
    });

    it('throws, naming the field, when the index holds a field no longer declared', async () => {
      await OpenSearchBackend({ client, fields, indexName }).createIndex();

      const fewer = OpenSearchBackend({ client, fields: { name: { type: 'text' } }, indexName });

      await expect(fewer.createIndex()).rejects.toThrow('"inLanguage"');
    });

    it('throws, naming the field, on an index created some other way', async () => {
      await client.indices.create({ index: indexName });

      await expect(OpenSearchBackend({ client, fields, indexName }).createIndex()).rejects.toThrow('"id"');
    });

    it('uses the entities index by default', async () => {
      const exists = vi.fn().mockResolvedValue({ body: false });
      const create = vi.fn().mockResolvedValue({ body: {} });
      const fakeClient = { indices: { exists, create } } as unknown as Client;

      await OpenSearchBackend({ client: fakeClient, fields }).createIndex();

      expect(exists).toHaveBeenCalledWith({ index: 'entities' });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ index: 'entities' }));
    });
  });

  describe('index', () => {
    it('throws, naming the entity, when OpenSearch rejects a search document', async () => {
      await client.indices.create({
        index: indexName,
        body: { mappings: { properties: { name: { type: 'long' } } } },
      });

      await expect(
        OpenSearchBackend({ client, fields, indexName }).index([{ id: 'http://example.com/1', name: 'One' }]),
      ).rejects.toThrow('"http://example.com/1"');
    });
  });

  describe('remove', () => {
    it('does nothing before the index exists', async () => {
      await expect(OpenSearchBackend({ client, fields, indexName }).remove(['http://example.com/1'])).resolves.toBe(
        undefined,
      );
    });
  });
});
