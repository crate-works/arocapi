import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllVisibleSearchFilter, LicenceAccess } from '../app.js';
import { Prisma } from '../generated/prisma/client.js';
import { OpenSearchBackend } from '../search/opensearch/opensearch.js';
import { PostgresBackend } from '../search/postgres/postgres.js';
import { DirectoryStorage } from '../storage/directory/directory.js';
import { EntityMetaMetadata } from '../storage/entity-meta/entity-meta.js';
import { S3Storage } from '../storage/s3/s3.js';
import type { AuthorisedEntity, AuthorisedFile } from '../transformers/default.js';
import type { StandardErrorResponse } from '../utils/errors.js';
import { putTestObjects, testS3Client } from './helpers/s3.js';
import { describeSearchBackendContract } from './helpers/searchBackendContract.js';
import { describeStorageContract } from './helpers/storageBackendContract.js';
import {
  buildTestApp,
  cleanupTestData,
  getTestApp,
  getTestOpenSearch,
  getTestPrisma,
  seedTestData,
  setupIntegrationTests,
  teardownIntegrationTests,
} from './integration.setup.js';

describe.each(['OpenSearchBackend', 'PostgresBackend'] as const)('Integration Tests with %s', (backend) => {
  beforeAll(async () => {
    await setupIntegrationTests(backend);
  });

  afterAll(async () => {
    await teardownIntegrationTests();
  });

  beforeEach(async () => {
    await seedTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe('GET /entity/:id', () => {
    it('should return entity from database', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: `/entity/${encodeURIComponent('http://example.com/entity/1')}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchSnapshot();
    });

    it('should return File entity from database', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: `/entity/${encodeURIComponent('http://example.com/entity/4')}`,
      });
      const body = JSON.parse(response.body) as AuthorisedEntity;

      expect(response.statusCode).toBe(200);
      expect(body.id).toBe('http://example.com/entity/4');
      expect(body.name).toBe('test-audio.wav');
      expect(body.entityType).toBe('http://schema.org/MediaObject');
      expect(body.memberOf?.id).toBe('http://example.com/entity/2');
      expect(body.rootCollection?.id).toBe('http://example.com/entity/1');
    });

    it('should return 404 for non-existent entity', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entity/http://example.com/entity/nonexistent',
      });
      const body = JSON.parse(response.body) as StandardErrorResponse;

      expect(response.statusCode).toBe(404);
      expect(body.error).toBe('Not Found');
    });
  });

  describe('GET /entities', () => {
    it('should return all entities with pagination', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(5);
      expect(body.entities).toHaveLength(5);
      expect(body.entities[0]).toEqual({
        id: 'http://example.com/entity/1',
        name: 'Test Collection',
        description: 'First test entity',
        entityType: 'http://pcdm.org/models#Collection',
        memberOf: null,
        rootCollection: null,
        metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        access: {
          metadata: true,
          content: true,
        },
      });
    });

    it('should filter entities by memberOf', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          memberOf: 'http://example.com/entity/1',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(3);
      expect(body.entities).toHaveLength(3);
      expect(body.entities[0].id).toBe('http://example.com/entity/2');
    });

    it('should filter entities by entityType', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          entityType: 'http://schema.org/Person',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(1);
      expect(body.entities).toHaveLength(1);
      expect(body.entities[0].id).toBe('http://example.com/entity/3');
    });

    it('should filter entities by File entityType', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          entityType: 'http://schema.org/MediaObject',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(2);
      expect(body.entities).toHaveLength(2);
      expect(body.entities[0].entityType).toBe('http://schema.org/MediaObject');
      expect(body.entities[1].entityType).toBe('http://schema.org/MediaObject');
    });

    it('should filter entities by repeated entityType parameters', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          entityType: ['http://pcdm.org/models#Collection', 'http://pcdm.org/models#Object'],
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(2);
      expect(body.entities.map((e) => e.id)).toEqual(['http://example.com/entity/1', 'http://example.com/entity/2']);
    });

    it('should treat a comma-separated entityType as a single type', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          entityType: 'http://pcdm.org/models#Collection,http://pcdm.org/models#Object',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(0);
      expect(body.entities).toEqual([]);
    });

    it('should apply no entityType filter when the value is empty', async () => {
      const app = getTestApp();

      const response = await app.inject({ method: 'GET', url: '/entities?entityType=' });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(5);
    });

    it('should ignore blank repeated entityType values', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          entityType: ['', '  ', ' http://schema.org/Person '],
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(1);
      expect(body.entities.map((e) => e.id)).toEqual(['http://example.com/entity/3']);
    });

    it.each([
      ['alone', 'not-a-uri'],
      ['alongside a valid one', ['http://schema.org/Person', 'not-a-uri']],
    ])('should reject an entityType that is not a URI %s', async (_label, entityType) => {
      const app = getTestApp();

      const response = await app.inject({ method: 'GET', url: '/entities', query: { entityType } });
      const body = JSON.parse(response.body) as StandardErrorResponse;
      const violations = body.error.details?.violations as { field: string }[];

      expect(response.statusCode).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(violations.some((v) => v.field.startsWith('/entityType'))).toBe(true);
    });

    it('should apply no entityType filter when all repeated values are blank', async () => {
      const app = getTestApp();

      const response = await app.inject({ method: 'GET', url: '/entities?entityType=&entityType=' });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(5);
    });

    it('should combine repeated entityType parameters with memberOf and pagination', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          memberOf: 'http://example.com/entity/1',
          entityType: ['http://pcdm.org/models#Object', 'http://schema.org/MediaObject'],
          limit: '1',
          offset: '1',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(2);
      expect(body.entities.map((e) => e.id)).toEqual(['http://example.com/entity/5']);
    });

    it('should filter File entities by memberOf (Object parent)', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          memberOf: 'http://example.com/entity/2',
          entityType: 'http://schema.org/MediaObject',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(1);
      expect(body.entities).toHaveLength(1);
      expect(body.entities[0].id).toBe('http://example.com/entity/4');
      expect(body.entities[0].name).toBe('test-audio.wav');
      expect(body.entities[0].memberOf?.id).toBe('http://example.com/entity/2');
    });

    it('should filter File entities by memberOf (Collection parent)', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          memberOf: 'http://example.com/entity/1',
          entityType: 'http://schema.org/MediaObject',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(1);
      expect(body.entities).toHaveLength(1);
      expect(body.entities[0].id).toBe('http://example.com/entity/5');
      expect(body.entities[0].name).toBe('collection-metadata.csv');
      expect(body.entities[0].memberOf?.id).toBe('http://example.com/entity/1');
    });

    it('should handle pagination', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          limit: '2',
          offset: '1',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(5);
      expect(body.entities).toHaveLength(2);
    });

    it('should sort entities by name', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          sort: 'name',
          order: 'desc',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.entities.map((entity) => entity.name)).toEqual([
        'Test Person',
        'Test Object',
        'Test Collection',
        'test-audio.wav',
        'collection-metadata.csv',
      ]);
    });
  });

  describe('GET /files', () => {
    it('should return all files', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/files',
      });
      const body = JSON.parse(response.body) as { total: number; files: AuthorisedFile[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(2);
      expect(body.files).toHaveLength(2);
    });

    it('should filter files by memberOf (Object parent)', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/files',
        query: {
          memberOf: 'http://example.com/entity/2',
        },
      });
      const body = JSON.parse(response.body) as { total: number; files: AuthorisedFile[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(1);
      expect(body.files).toHaveLength(1);
      expect(body.files[0].id).toBe('http://example.com/entity/4');
      expect(body.files[0].filename).toBe('test-audio.wav');
    });

    it('should filter files by memberOf (Collection parent)', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/files',
        query: {
          memberOf: 'http://example.com/entity/1',
        },
      });
      const body = JSON.parse(response.body) as { total: number; files: AuthorisedFile[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(1);
      expect(body.files).toHaveLength(1);
      expect(body.files[0].id).toBe('http://example.com/entity/5');
      expect(body.files[0].filename).toBe('collection-metadata.csv');
    });

    it('should return empty list when memberOf matches no entity', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/files',
        query: {
          memberOf: 'http://example.com/entity/does-not-exist',
        },
      });
      const body = JSON.parse(response.body) as { total: number; files: AuthorisedFile[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(0);
      expect(body.files).toHaveLength(0);
    });
  });

  describe('POST /search', () => {
    it('should perform basic search', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          searchType: 'basic',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBeGreaterThan(0);
      expect(body.entities).toBeDefined();
      expect(Array.isArray(body.entities)).toBe(true);
    });

    it('should handle search with no results', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'nonexistentterm',
          searchType: 'basic',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBe(0);
      expect(body.entities).toHaveLength(0);
    });

    it('should return aggregations', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          searchType: 'basic',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[]; facets: null };

      expect(response.statusCode).toBe(200);
      expect(body.facets).toBeDefined();
    });

    it('should handle search pagination', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          limit: 1,
          offset: 0,
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.entities.length).toBeLessThanOrEqual(1);
    });

    it('should sort entities by name', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          sort: 'name',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.entities[0].name).toBe('Test Collection');
      expect(body.entities[1].name).toBe('Test Object');
      expect(body.entities[2].name).toBe('Test Person');
    });

    it('should filter search results by File entityType', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'test',
          searchType: 'basic',
          filters: {
            entityType: ['http://schema.org/MediaObject'],
          },
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.entities.every((e) => e.entityType === 'http://schema.org/MediaObject')).toBe(true);
    });

    it('should search for File entities by name', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/search',
        payload: {
          query: 'audio',
          searchType: 'basic',
        },
      });
      const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

      expect(response.statusCode).toBe(200);
      expect(body.total).toBeGreaterThan(0);
      const audioFile = body.entities.find((e) => e.name === 'test-audio.wav');
      expect(audioFile).toBeDefined();
      expect(audioFile?.entityType).toBe('http://schema.org/MediaObject');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid entity ID format', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entity/invalid-id',
      });
      const body = JSON.parse(response.body) as StandardErrorResponse;

      expect(response.statusCode).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should handle invalid query parameters for entities', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/entities',
        query: {
          limit: '-1',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should handle missing search query', async () => {
      const app = getTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/search',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Visibility', () => {
    const entityUrl = (n: number) => encodeURIComponent(`http://example.com/entity/${n}`);
    const hideDrafts = {
      OR: [{ meta: { path: ['draft'], equals: Prisma.AnyNull } }, { meta: { path: ['draft'], not: true } }],
    };
    const hideDraftsSearch = { draft: { not: true } };
    const storage = {
      metadata: () => ({ type: 'redirect' as const, url: 'https://files.example.com/crate' }),
      content: () => ({ type: 'redirect' as const, url: 'https://files.example.com/file' }),
    };

    let app: FastifyInstance;

    beforeAll(async () => {
      app = await buildTestApp({
        storage,
        entityVisibilityFilter: () => hideDrafts,
        searchVisibilityFilter: () => hideDraftsSearch,
        isAuthenticated: ({ request }) => request.headers['x-user'] !== undefined,
        promptLoginForHidden: true,
      });
    });

    afterAll(async () => {
      await app.close();
    });

    const ids = (entities: Array<{ id: string }>) => entities.map((e) => e.id).sort();
    const signedIn = { 'x-user': 'alice' };

    describe('single entity routes', () => {
      it('treats a hidden entity like a missing one for an authenticated request', async () => {
        const hidden = await app.inject({ method: 'GET', url: `/entity/${entityUrl(2)}`, headers: signedIn });
        const missing = await app.inject({ method: 'GET', url: `/entity/${entityUrl(99)}`, headers: signedIn });

        expect(hidden.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
        const { error: hiddenError } = hidden.json<StandardErrorResponse>();
        const { error: missingError } = missing.json<StandardErrorResponse>();
        expect(hiddenError.code).toBe(missingError.code);
        expect(hiddenError.message).toBe(missingError.message);
      });

      it('prompts an anonymous request for a hidden entity to log in', async () => {
        const response = await app.inject({ method: 'GET', url: `/entity/${entityUrl(2)}` });

        expect(response.statusCode).toBe(401);
        expect(response.json<StandardErrorResponse>().error.code).toBe('UNAUTHORIZED');
      });

      it('still returns 404 for a missing entity to an anonymous request', async () => {
        const response = await app.inject({ method: 'GET', url: `/entity/${entityUrl(99)}` });

        expect(response.statusCode).toBe(404);
      });

      it('resolves parent references regardless of visibility', async () => {
        const response = await app.inject({ method: 'GET', url: `/entity/${entityUrl(4)}` });
        const body = JSON.parse(response.body) as AuthorisedEntity;

        expect(response.statusCode).toBe(200);
        expect(body.memberOf).toEqual({ id: 'http://example.com/entity/2', name: 'Test Object' });
        expect(body.rootCollection).toEqual({ id: 'http://example.com/entity/1', name: 'Test Collection' });
      });

      it.each(['GET', 'HEAD'] as const)(
        'prompts login for a hidden entity on %s /entity/:id/metadata',
        async (method) => {
          const hidden = await app.inject({ method, url: `/entity/${entityUrl(2)}/metadata` });
          const signedInHidden = await app.inject({
            method,
            url: `/entity/${entityUrl(2)}/metadata`,
            headers: signedIn,
          });
          const visible = await app.inject({ method, url: `/entity/${entityUrl(1)}/metadata` });

          expect(hidden.statusCode).toBe(401);
          expect(signedInHidden.statusCode).toBe(404);
          expect(visible.statusCode).toBe(302);
        },
      );

      it.each(['GET', 'HEAD'] as const)('prompts login for a hidden file on %s /file/:id', async (method) => {
        const hidden = await app.inject({ method, url: `/file/${entityUrl(5)}` });
        const missing = await app.inject({ method, url: `/file/${entityUrl(99)}` });
        const visible = await app.inject({ method, url: `/file/${entityUrl(4)}` });

        expect(hidden.statusCode).toBe(401);
        expect(missing.statusCode).toBe(404);
        expect(visible.statusCode).toBe(302);
      });

      it('returns 404 for a hidden entity to anonymous requests without the login prompt', async () => {
        const defaultApp = await buildTestApp({
          entityVisibilityFilter: () => hideDrafts,
          isAuthenticated: () => false,
        });

        const hidden = await defaultApp.inject({ method: 'GET', url: `/entity/${entityUrl(2)}` });
        await defaultApp.close();

        expect(hidden.statusCode).toBe(404);
      });
    });

    describe('list routes', () => {
      it('excludes hidden entities from /entities and its total', async () => {
        const response = await app.inject({ method: 'GET', url: '/entities?limit=2' });
        const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

        expect(body.total).toBe(3);
        expect(ids(body.entities)).toEqual(['http://example.com/entity/1', 'http://example.com/entity/3']);
      });

      it('combines memberOf with visibility on /entities', async () => {
        const response = await app.inject({ method: 'GET', url: `/entities?memberOf=${entityUrl(1)}` });
        const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

        expect(body.total).toBe(1);
        expect(ids(body.entities)).toEqual(['http://example.com/entity/3']);
      });

      it('combines entityType with visibility on /entities', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/entities?entityType=${encodeURIComponent('http://schema.org/MediaObject')}`,
        });
        const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

        expect(body.total).toBe(1);
        expect(ids(body.entities)).toEqual(['http://example.com/entity/4']);
      });

      it('excludes files of hidden entities from /files and its total', async () => {
        const response = await app.inject({ method: 'GET', url: '/files' });
        const body = JSON.parse(response.body) as { total: number; files: AuthorisedFile[] };

        expect(body.total).toBe(1);
        expect(ids(body.files)).toEqual(['http://example.com/entity/4']);
      });

      it('excludes hidden entities from /search results, total and facets', async () => {
        const response = await app.inject({ method: 'POST', url: '/search', payload: { query: '' } });
        const body = JSON.parse(response.body) as {
          total: number;
          entities: AuthorisedEntity[];
          facets: Record<string, Array<{ name: string; count: number }>>;
        };

        expect(body.total).toBe(3);
        expect(ids(body.entities)).toEqual([
          'http://example.com/entity/1',
          'http://example.com/entity/3',
          'http://example.com/entity/4',
        ]);
        expect(body.facets.entityType.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
      });

      it('paginates /search over visible entities only', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/search',
          payload: { query: '', sort: 'name', limit: 2, offset: 2 },
        });
        const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

        expect(body.total).toBe(3);
        expect(ids(body.entities)).toEqual(['http://example.com/entity/4']);
      });

      it('drops search hits the entity visibility filter hides when the filters disagree', async () => {
        const mismatchedApp = await buildTestApp({
          entityVisibilityFilter: () => hideDrafts,
          searchVisibilityFilter: AllVisibleSearchFilter,
        });

        const response = await mismatchedApp.inject({ method: 'POST', url: '/search', payload: { query: '' } });
        await mismatchedApp.close();
        const body = JSON.parse(response.body) as { total: number; entities: AuthorisedEntity[] };

        expect(body.total).toBe(5);
        expect(ids(body.entities)).toEqual([
          'http://example.com/entity/1',
          'http://example.com/entity/3',
          'http://example.com/entity/4',
        ]);
      });
    });
  });

  describe('Access', () => {
    const entityUrl = (n: number) => encodeURIComponent(`http://example.com/entity/${n}`);
    const restrictedFile = 'http://example.com/entity/5';
    const restrictedMetadata = 'http://example.com/entity/2';
    const storage = {
      metadata: vi.fn(() => ({ type: 'redirect' as const, url: 'https://files.example.com/crate' })),
      content: vi.fn(() => ({ type: 'redirect' as const, url: 'https://files.example.com/file' })),
    };

    let app: FastifyInstance;

    beforeAll(async () => {
      app = await buildTestApp({
        storage,
        access: (entity) => ({
          metadata: entity.id !== restrictedMetadata,
          content: entity.id !== restrictedFile,
          ...(entity.id === restrictedFile && { contentAuthorizationUrl: 'https://rems.example.com/apply' }),
        }),
        entityTransformers: [(entity) => ({ ...entity, canDownload: entity.access.content })],
      });
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      vi.clearAllMocks();
    });

    describe('Content', () => {
      it.each(['GET', 'HEAD'] as const)('denies %s /file/:id with 403 without calling storage', async (method) => {
        const denied = await app.inject({ method, url: `/file/${entityUrl(5)}` });

        expect(denied.statusCode).toBe(403);
        expect(storage.content).not.toHaveBeenCalled();

        const granted = await app.inject({ method, url: `/file/${entityUrl(4)}` });

        expect(granted.statusCode).toBe(302);
        expect(storage.content).toHaveBeenCalledOnce();
      });

      it('denies the noRedirect variant without revealing the location', async () => {
        const denied = await app.inject({ method: 'GET', url: `/file/${entityUrl(5)}?noRedirect=true` });

        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain('files.example.com');
        expect(storage.content).not.toHaveBeenCalled();
      });
    });

    describe('Metadata', () => {
      it.each(['GET', 'HEAD'] as const)('denies %s /entity/:id/metadata without calling storage', async (method) => {
        const denied = await app.inject({ method, url: `/entity/${entityUrl(2)}/metadata` });

        expect(denied.statusCode).toBe(403);
        expect(storage.metadata).not.toHaveBeenCalled();

        const granted = await app.inject({ method, url: `/entity/${entityUrl(1)}/metadata` });

        expect(granted.statusCode).toBe(302);
        expect(storage.metadata).toHaveBeenCalledOnce();
      });
    });

    describe('access signal', () => {
      const restrictedFileAccess = {
        metadata: true,
        content: false,
        contentAuthorizationUrl: 'https://rems.example.com/apply',
      };

      it('attaches access to /entity/:id before entity transformers run', async () => {
        const response = await app.inject({ method: 'GET', url: `/entity/${entityUrl(5)}` });
        const body = response.json<AuthorisedEntity & { canDownload: boolean }>();

        expect(body.access).toEqual(restrictedFileAccess);
        expect(body.canDownload).toBe(false);
      });

      it('attaches access to every entity in /entities and /search', async () => {
        const listing = await app.inject({ method: 'GET', url: '/entities' });
        const search = await app.inject({ method: 'POST', url: '/search', payload: { query: '' } });

        for (const response of [listing, search]) {
          const { entities } = response.json<{ entities: AuthorisedEntity[] }>();
          const byId = new Map(entities.map((e) => [e.id, e.access]));

          expect(byId.get('http://example.com/entity/1')).toEqual({ metadata: true, content: true });
          expect(byId.get(restrictedMetadata)).toEqual({ metadata: false, content: true });
          expect(byId.get(restrictedFile)).toEqual(restrictedFileAccess);
        }
      });

      it("gives each file in /files its file entity's content access", async () => {
        const response = await app.inject({ method: 'GET', url: '/files' });
        const { files } = response.json<{ files: AuthorisedFile[] }>();
        const byId = new Map(files.map((f) => [f.id, f.access]));

        expect(byId.get('http://example.com/entity/4')).toEqual({ content: true });
        expect(byId.get(restrictedFile)).toEqual({
          content: false,
          contentAuthorizationUrl: 'https://rems.example.com/apply',
        });
      });

      it('ignores anything but access returned by the access function', async () => {
        const leakyApp = await buildTestApp({
          access: (entity) => ({ ...entity, name: 'Redacted', metadata: true, content: true }),
        });

        const response = await leakyApp.inject({ method: 'GET', url: `/entity/${entityUrl(1)}` });
        await leakyApp.close();
        const body = response.json<AuthorisedEntity>();

        expect(body.name).toBe('Test Collection');
        expect(body.access).toEqual({ metadata: true, content: true });
      });
    });

    describe('licence access', () => {
      const licence = 'https://creativecommons.org/licenses/by/4.0/';
      const restrictedLicence = 'https://example.com/licences/restricted';
      const hasLicence = vi.fn();
      let licenceApp: FastifyInstance;

      beforeAll(async () => {
        licenceApp = await buildTestApp({
          access: LicenceAccess({
            hasLicence,
            authorisationUrl: (licenceId) => `https://rems.example.com/apply?licence=${encodeURIComponent(licenceId)}`,
          }),
        });
      });

      afterAll(async () => {
        await licenceApp.close();
      });

      it('checks each licence once per request across a listing', async () => {
        hasLicence.mockImplementation(async (licenceId: string) => licenceId === licence);

        const first = await licenceApp.inject({ method: 'GET', url: '/entities' });
        const second = await licenceApp.inject({ method: 'GET', url: '/entities' });
        const byId = new Map(first.json<{ entities: AuthorisedEntity[] }>().entities.map((e) => [e.id, e.access]));

        expect(byId.size).toBe(5);
        expect(byId.get('http://example.com/entity/4')).toMatchObject({ metadata: true, content: false });
        expect(byId.get('http://example.com/entity/5')).toMatchObject({ metadata: true, content: true });
        expect(second.statusCode).toBe(200);
        expect(hasLicence).toHaveBeenCalledTimes(4);
        expect(hasLicence).toHaveBeenCalledWith(licence, expect.objectContaining({ request: expect.anything() }));
        expect(hasLicence).toHaveBeenCalledWith(restrictedLicence, expect.anything());
      });

      it('grants access without authorisation URLs when the licence is held', async () => {
        hasLicence.mockReturnValue(true);

        const response = await licenceApp.inject({ method: 'GET', url: `/entity/${entityUrl(1)}` });

        expect(response.json<AuthorisedEntity>().access).toEqual({ metadata: true, content: true });
      });

      it('denies access with authorisation URLs when the licence is not held', async () => {
        hasLicence.mockResolvedValue(false);
        const applyUrl = (licenceId: string) =>
          `https://rems.example.com/apply?licence=${encodeURIComponent(licenceId)}`;

        const entity = await licenceApp.inject({ method: 'GET', url: `/entity/${entityUrl(4)}` });
        const content = await licenceApp.inject({ method: 'GET', url: `/file/${entityUrl(4)}` });

        expect(entity.json<AuthorisedEntity>().access).toEqual({
          metadata: false,
          content: false,
          metadataAuthorizationUrl: applyUrl(licence),
          contentAuthorizationUrl: applyUrl(restrictedLicence),
        });
        expect(content.statusCode).toBe(403);
      });

      it('omits authorisation URLs when no builder is given', async () => {
        const bareApp = await buildTestApp({ access: LicenceAccess({ hasLicence: () => false }) });

        const response = await bareApp.inject({ method: 'GET', url: `/entity/${entityUrl(1)}` });
        await bareApp.close();

        expect(response.json<AuthorisedEntity>().access).toEqual({ metadata: false, content: false });
      });
    });

    describe('denied requests', () => {
      const signedIn = { 'x-user': 'alice' };
      let deniedApp: FastifyInstance;

      beforeAll(async () => {
        deniedApp = await buildTestApp({
          storage,
          entityVisibilityFilter: () => ({ id: { not: 'http://example.com/entity/3' } }),
          access: () => ({ metadata: false, content: false }),
          isAuthenticated: ({ request }) => request.headers['x-user'] !== undefined,
        });
      });

      afterAll(async () => {
        await deniedApp.close();
      });

      it.each([
        ['an anonymous', {}, 401, 'UNAUTHORIZED'],
        ['an authenticated', signedIn, 403, 'FORBIDDEN'],
      ])('refuses %s request', async (_who, headers, status, code) => {
        const metadata = await deniedApp.inject({ method: 'GET', url: `/entity/${entityUrl(1)}/metadata`, headers });
        const content = await deniedApp.inject({ method: 'GET', url: `/file/${entityUrl(4)}`, headers });

        expect(metadata.statusCode).toBe(status);
        expect(metadata.json<StandardErrorResponse>().error.code).toBe(code);
        expect(content.statusCode).toBe(status);
        expect(content.json<StandardErrorResponse>().error.code).toBe(code);
      });

      it('refuses with 403 when the repository has no logins', async () => {
        const noLoginApp = await buildTestApp({ storage, access: () => ({ metadata: false, content: false }) });

        const response = await noLoginApp.inject({ method: 'GET', url: `/entity/${entityUrl(1)}/metadata` });
        await noLoginApp.close();

        expect(response.statusCode).toBe(403);
      });

      it('gives hidden and missing entities 404, not a denied response', async () => {
        const hidden = await deniedApp.inject({ method: 'GET', url: `/entity/${entityUrl(3)}/metadata` });
        const missing = await deniedApp.inject({ method: 'GET', url: `/file/${entityUrl(99)}` });

        expect(hidden.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
      });
    });
  });

  if (backend === 'OpenSearchBackend') {
    describeSearchBackendContract(backend, {
      create: (fields) =>
        OpenSearchBackend({
          client: getTestOpenSearch(),
          fields,
          indexName: 'search-contract-test',
          refresh: true,
        }),
      prepare: async (search) => {
        await getTestOpenSearch().indices.delete({ index: 'search-contract-test', ignore_unavailable: true });
        await search.createIndex();
      },
    });
  } else {
    describeSearchBackendContract(backend, {
      create: (fields) => PostgresBackend({ prisma: getTestPrisma(), fields }),
      prepare: async () => {
        await getTestPrisma().entitySearch.deleteMany({});
      },
    });
  }
});

describe('Storage backends', () => {
  beforeAll(async () => {
    await setupIntegrationTests('PostgresBackend');
  });

  afterAll(async () => {
    await teardownIntegrationTests();
  });

  describe('DirectoryStorage', () => {
    let root: string;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'arocapi-directory-'));
    });

    afterAll(async () => {
      await rm(root, { recursive: true });
    });

    describeStorageContract<string>('DirectoryStorage', {
      create: (locate) => DirectoryStorage({ root, locate }),
      prepare: async (items) => {
        for (const { path, body } of items) {
          await mkdir(dirname(join(root, path)), { recursive: true });
          await writeFile(join(root, path), body);
        }
      },
      meta: (path) => ({ storagePath: path }),
      key: (path) => path,
    });
  });

  describe('EntityMetaMetadata', () => {
    let root: string;
    const crates = new Map<string, Prisma.InputJsonObject>();

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'arocapi-entity-meta-'));
    });

    afterAll(async () => {
      await rm(root, { recursive: true });
    });

    describeStorageContract<string>('EntityMetaMetadata mixed with DirectoryStorage', {
      create: (locate) => ({
        metadata: EntityMetaMetadata(),
        content: DirectoryStorage({ root, locate: { content: locate?.content } }).content,
      }),
      prepare: async (items) => {
        for (const { path, body } of items) {
          if (path.endsWith('.json')) {
            crates.set(path, JSON.parse(body) as Prisma.InputJsonObject);
          } else {
            await mkdir(dirname(join(root, path)), { recursive: true });
            await writeFile(join(root, path), body);
          }
        }
      },
      meta: (path) => ({ storagePath: path, ...(crates.has(path) && { rocrate: crates.get(path) }) }),
      key: (path) => path,
      keylessMetadata: true,
    });
  });

  describe('S3Storage', () => {
    const client = testS3Client();

    afterAll(() => {
      client.destroy();
    });

    describe.each(['redirect', 'stream'] as const)('with %s delivery', (delivery) => {
      const bucket = `storage-contract-${delivery}`;

      describeStorageContract<string>(`S3Storage (${delivery})`, {
        create: (locate) => S3Storage({ client, bucket, locate, delivery }),
        prepare: (items) => putTestObjects(client, bucket, items),
        meta: (path) => ({ storageKey: path }),
        key: (path) => path,
      });
    });
  });
});
