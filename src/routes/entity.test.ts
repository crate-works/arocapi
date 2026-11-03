import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fastify, fastifyAfter, fastifyBefore, prisma } from '../test/helpers/fastify.js';
import type { EntityRow } from '../transformers/default.js';
import type { AccessFunction } from '../types/access.js';
import { AllPublicAccess } from '../utils/access.js';
import type { StandardErrorResponse } from '../utils/errors.js';
import { AllVisibleEntityFilter } from '../utils/visibility.js';
import entityRoute from './entity.js';

describe('Entity Route', () => {
  beforeEach(async () => {
    await fastifyBefore();
    await fastify.register(entityRoute, {
      entityVisibilityFilter: AllVisibleEntityFilter,
      refusal: { promptLoginForHidden: false },
      prisma,
      access: AllPublicAccess,
    });
  });

  afterEach(async () => {
    await fastifyAfter();
  });

  describe('GET /entity/:id', () => {
    it('should return entity when found', async () => {
      const mockEntity = {
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        description: 'A test entity',
        entityType: 'http://schema.org/Person',

        memberOf: null,
        rootCollection: null,
        metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        createdAt: new Date(),
        updatedAt: new Date(),
        meta: {},
      };

      prisma.entity.findFirst.mockResolvedValue(mockEntity);

      const response = await fastify.inject({
        method: 'GET',
        url: `/entity/${encodeURIComponent('http://example.com/entity/123')}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchSnapshot();
      expect(prisma.entity.findFirst).toHaveBeenCalledWith({
        where: { AND: [{ id: 'http://example.com/entity/123' }, {}] },
        include: { file: { select: { id: true } } },
      });
    });

    it('should return 404 when entity not found', async () => {
      prisma.entity.findFirst.mockResolvedValue(null);

      const response = await fastify.inject({
        method: 'GET',
        url: `/entity/${encodeURIComponent('http://example.com/entity/nonexistent')}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(404);
      expect(body).toMatchSnapshot();
    });

    it('should return 500 when database error occurs', async () => {
      prisma.entity.findFirst.mockRejectedValue(new Error('Database connection failed'));

      const response = await fastify.inject({
        method: 'GET',
        url: `/entity/${encodeURIComponent('http://example.com/entity/123')}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(500);
      expect(body).toMatchSnapshot();
    });

    it('should validate ID parameter format', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/entity/invalid-id',
      });
      const body = JSON.parse(response.body) as StandardErrorResponse;

      expect(response.statusCode).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should apply custom entity transformers', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: fine in tests
      const customTransformer = async (entity: any) => ({
        ...entity,
        tested: true,
      });

      await fastifyBefore();
      await fastify.register(entityRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        refusal: { promptLoginForHidden: false },
        prisma,
        access: AllPublicAccess,
        entityTransformers: [customTransformer],
      });

      const mockEntity = {
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        description: 'A test entity',
        entityType: 'http://pcdm.org/models#Collection',
        memberOf: null,
        rootCollection: null,
        metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // @ts-expect-error TS is looking at the wronf function signature
      prisma.entity.findFirst.mockResolvedValue(mockEntity);

      const response = await fastify.inject({
        method: 'GET',
        url: `/entity/${encodeURIComponent('http://example.com/entity/123')}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchSnapshot();
    });

    it('gives entity transformers the entity row without sending it', async () => {
      const rows: EntityRow[] = [];
      await fastifyBefore();
      await fastify.register(entityRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        refusal: { promptLoginForHidden: false },
        prisma,
        access: AllPublicAccess,
        entityTransformers: [
          (entity, _context, row) => {
            rows.push(row);

            return entity;
          },
        ],
      });
      const row = {
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        description: 'A test entity',
        entityType: 'http://pcdm.org/models#Object',
        memberOf: null,
        rootCollection: null,
        metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        meta: { accessControl: 'Restricted' },
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-02-01'),
      };
      prisma.entity.findFirst.mockResolvedValue({ ...row, file: null } as typeof row);

      const response = await fastify.inject({
        method: 'GET',
        url: `/entity/${encodeURIComponent(row.id)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(rows).toEqual([row]);
      expect(response.json()).not.toHaveProperty('meta');
      expect(response.json()).not.toHaveProperty('createdAt');
    });

    it('decides access with the entity row without sending it', async () => {
      const rows: EntityRow[] = [];
      const access: AccessFunction = (_entity, _context, row) => {
        rows.push(row);
        const open = (row.meta as { accessControl?: string } | null)?.accessControl !== 'Restricted';

        return { metadata: open, content: open };
      };
      await fastifyBefore();
      await fastify.register(entityRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        refusal: { promptLoginForHidden: false },
        prisma,
        access,
      });
      const row = {
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        description: 'A test entity',
        entityType: 'http://pcdm.org/models#Object',
        memberOf: null,
        rootCollection: null,
        metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        meta: { accessControl: 'Restricted' },
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-02-01'),
      };
      prisma.entity.findFirst.mockResolvedValue({ ...row, file: null } as typeof row);

      const response = await fastify.inject({
        method: 'GET',
        url: `/entity/${encodeURIComponent(row.id)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(rows).toEqual([row]);
      expect(response.json()).toMatchObject({ access: { metadata: false, content: false } });
      expect(response.json()).not.toHaveProperty('meta');
    });

    it('should return null for memberOf/rootCollection when parent entity not found', async () => {
      const mockEntity = {
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        description: 'A test entity',
        entityType: 'http://pcdm.org/models#Object',

        memberOf: 'http://example.com/entity/deleted',
        rootCollection: 'http://example.com/entity/deleted',
        metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        createdAt: new Date(),
        updatedAt: new Date(),
        meta: {},
      };

      // First call returns the entity, second call (for reference resolution) returns empty
      prisma.entity.findFirst.mockResolvedValue(mockEntity);
      prisma.entity.findMany.mockResolvedValue([]);

      const response = await fastify.inject({
        method: 'GET',
        url: `/entity/${encodeURIComponent('http://example.com/entity/123')}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toMatchSnapshot();
    });
  });
});
