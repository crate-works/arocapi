import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fastify, fastifyAfter, fastifyBefore, prisma } from '../test/helpers/fastify.js';
import { entityRow, recordRows, restrictedByMeta } from '../test/helpers/rows.js';
import type { EntityRow } from '../transformers/default.js';
import { AllPublicAccess } from '../utils/access.js';
import { AllVisibleEntityFilter } from '../utils/visibility.js';
import entitiesRoute from './entities.js';

describe('Entities Route', () => {
  beforeEach(async () => {
    await fastifyBefore();
    await fastify.register(entitiesRoute, {
      entityVisibilityFilter: AllVisibleEntityFilter,
      prisma,
      access: AllPublicAccess,
    });
  });

  afterEach(async () => {
    await fastifyAfter();
  });

  describe('GET /entities', () => {
    it('should return entities with default pagination', async () => {
      const mockEntities = [
        {
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'First test entity',
          entityType: 'http://pcdm.org/models#Collection',

          memberOf: null,
          rootCollection: null,
          metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          createdAt: new Date(),
          updatedAt: new Date(),
          meta: {},
        },
        {
          id: 'http://example.com/entity/2',
          name: 'Test Entity 2',
          description: 'Second test entity',
          entityType: 'http://pcdm.org/models#Object',

          memberOf: 'http://example.com/entity/1',
          rootCollection: 'http://example.com/entity/1',
          metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          createdAt: new Date(),
          updatedAt: new Date(),
          meta: {},
        },
      ];

      prisma.entity.findMany.mockResolvedValue(mockEntities);
      prisma.entity.count.mockResolvedValue(2);

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchSnapshot();
      expect(prisma.entity.findMany).toHaveBeenCalledWith({
        where: { AND: [{}, {}] },
        orderBy: { id: 'asc' },
        skip: 0,
        take: 100,
      });
    });

    it('should filter by memberOf', async () => {
      prisma.entity.findMany.mockResolvedValue([]);
      prisma.entity.count.mockResolvedValue(0);

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
        query: {
          memberOf: 'http://example.com/collection/1',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.entity.findMany).toHaveBeenCalledWith({
        where: { AND: [{ memberOf: 'http://example.com/collection/1' }, {}] },
        orderBy: { id: 'asc' },
        skip: 0,
        take: 100,
      });
    });

    it('should filter by single entity type', async () => {
      prisma.entity.findMany.mockResolvedValue([]);
      prisma.entity.count.mockResolvedValue(0);

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
        query: {
          entityType: 'http://pcdm.org/models#Collection',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.entity.findMany).toHaveBeenCalledWith({
        where: { AND: [{ entityType: { in: ['http://pcdm.org/models#Collection'] } }, {}] },
        orderBy: { id: 'asc' },
        skip: 0,
        take: 100,
      });
    });

    it('should filter by multiple entity types', async () => {
      prisma.entity.findMany.mockResolvedValue([]);
      prisma.entity.count.mockResolvedValue(0);

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
        query: {
          entityType: ['http://pcdm.org/models#Collection', 'http://pcdm.org/models#Object'],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.entity.findMany).toHaveBeenCalledWith({
        where: {
          AND: [{ entityType: { in: ['http://pcdm.org/models#Collection', 'http://pcdm.org/models#Object'] } }, {}],
        },
        orderBy: { id: 'asc' },
        skip: 0,
        take: 100,
      });
    });

    it('should handle pagination parameters', async () => {
      prisma.entity.findMany.mockResolvedValue([]);
      prisma.entity.count.mockResolvedValue(0);

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
        query: {
          limit: '50',
          offset: '10',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.entity.findMany).toHaveBeenCalledWith({
        where: { AND: [{}, {}] },
        orderBy: { id: 'asc' },
        skip: 10,
        take: 50,
      });
    });

    it('should handle sorting by name descending', async () => {
      prisma.entity.findMany.mockResolvedValue([]);
      prisma.entity.count.mockResolvedValue(0);

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
        query: {
          sort: 'name',
          order: 'desc',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.entity.findMany).toHaveBeenCalledWith({
        where: { AND: [{}, {}] },
        orderBy: { name: 'desc' },
        skip: 0,
        take: 100,
      });
    });

    it('should sort by id field directly', async () => {
      prisma.entity.findMany.mockResolvedValue([]);
      prisma.entity.count.mockResolvedValue(0);

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
        query: {
          sort: 'id',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.entity.findMany).toHaveBeenCalledWith({
        where: { AND: [{}, {}] },
        orderBy: { id: 'asc' },
        skip: 0,
        take: 100,
      });
    });

    it('should return 500 when database error occurs', async () => {
      prisma.entity.findMany.mockRejectedValue(new Error('Database connection failed'));

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body).toMatchSnapshot();
    });

    it('should validate limit parameter bounds', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
        query: {
          limit: '0',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should validate negative offset', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
        query: {
          offset: '-1',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should apply custom entity transformers', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: fine in tests
      const customTransformer = async (entity: any) => ({
        ...entity,
        tested: true,
      });

      await fastifyBefore();
      await fastify.register(entitiesRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        prisma,
        access: AllPublicAccess,
        entityTransformers: [customTransformer],
      });

      const mockEntities = [
        {
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'First test entity',
          entityType: 'http://pcdm.org/models#Collection',
          memberOf: null,
          rootCollection: null,
          metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      // @ts-expect-error TS is looking at the wronf function signature
      prisma.entity.findMany.mockResolvedValue(mockEntities);

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchSnapshot();
    });

    it('gives entity transformers each entity row without sending it', async () => {
      const rows: EntityRow[] = [];
      await fastifyBefore();
      await fastify.register(entitiesRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        prisma,
        access: AllPublicAccess,
        entityTransformers: [recordRows(rows)],
      });
      const loaded = [1, 2].map((n) => entityRow({ id: `http://example.com/entity/${n}`, meta: { level: n } }));
      prisma.entity.findMany.mockResolvedValue(loaded);
      prisma.entity.count.mockResolvedValue(2);

      const response = await fastify.inject({ method: 'GET', url: '/entities' });

      expect(response.statusCode).toBe(200);
      expect(rows).toEqual(loaded);
      for (const entity of response.json().entities) {
        expect(entity).not.toHaveProperty('meta');
        expect(entity).not.toHaveProperty('createdAt');
      }
    });

    it('decides access with each entity row without sending it', async () => {
      const rows: EntityRow[] = [];
      await fastifyBefore();
      await fastify.register(entitiesRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        prisma,
        access: restrictedByMeta(rows),
      });
      const loaded = ['Restricted', 'Public'].map((accessControl, i) =>
        entityRow({ id: `http://example.com/entity/${i}`, meta: { accessControl } }),
      );
      prisma.entity.findMany.mockResolvedValue(loaded);
      prisma.entity.count.mockResolvedValue(2);

      const response = await fastify.inject({ method: 'GET', url: '/entities' });

      expect(response.statusCode).toBe(200);
      expect(rows).toEqual(loaded);
      const { entities } = response.json();
      expect(entities.map((e: { access: unknown }) => e.access)).toEqual([
        { metadata: false, content: false },
        { metadata: true, content: true },
      ]);
      for (const entity of entities) {
        expect(entity).not.toHaveProperty('meta');
      }
    });

    it('should return null for memberOf/rootCollection when parent entity not found', async () => {
      const mockEntities = [
        {
          id: 'http://example.com/entity/1',
          name: 'Test Entity 1',
          description: 'Entity with missing parent',
          entityType: 'http://pcdm.org/models#Object',

          memberOf: 'http://example.com/entity/deleted',
          rootCollection: 'http://example.com/entity/deleted',
          metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
          createdAt: new Date(),
          updatedAt: new Date(),
          meta: {},
        },
      ];

      // First call returns entities, second call (for reference resolution) returns empty
      prisma.entity.findMany.mockResolvedValueOnce(mockEntities);
      prisma.entity.findMany.mockResolvedValueOnce([]);
      prisma.entity.count.mockResolvedValue(1);

      const response = await fastify.inject({
        method: 'GET',
        url: '/entities',
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchSnapshot();
    });
  });
});
