import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { prisma } from '../test/helpers/fastify.js';
import type { AccessFunction } from '../types/access.js';
import type { RequestContext } from '../types/context.js';
import type { EntityTransformer } from '../types/transformers.js';
import {
  type AuthorisedEntity,
  applyTransformers,
  authoriseEntities,
  type BaseEntity,
  baseEntityTransformer,
  type EntityRow,
  type StandardEntity,
} from './default.js';

describe('Entity Transformers', () => {
  const mockContext: RequestContext = {
    request: {} as FastifyRequest,
    fastify: {} as FastifyInstance,
  };

  const mockStandardEntity: StandardEntity = {
    id: 'http://example.com/entity/123',
    name: 'Test Entity',
    description: 'A test entity',
    entityType: 'http://schema.org/Person',
    memberOf: { id: 'http://example.com/collection', name: 'Test Collection' },
    rootCollection: { id: 'http://example.com/root', name: 'Root Collection' },
    metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
    contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
  };

  const mockAuthorisedEntity: AuthorisedEntity = {
    ...mockStandardEntity,
    access: {
      metadata: true,
      content: true,
    },
  };

  const mockRow: EntityRow = {
    ...mockStandardEntity,
    memberOf: 'http://example.com/collection',
    rootCollection: 'http://example.com/root',
    meta: {},
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  describe('baseEntityTransformer', () => {
    it('should transform raw entity to base shape with unresolved references', () => {
      const rawEntity = {
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        description: 'A test entity',
        entityType: 'http://schema.org/Person',

        memberOf: 'http://example.com/collection',
        rootCollection: 'http://example.com/root',
        metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        meta: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = baseEntityTransformer(rawEntity);

      // baseEntityTransformer returns BaseEntity with string references
      const expectedBaseEntity: BaseEntity = {
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        description: 'A test entity',
        entityType: 'http://schema.org/Person',
        memberOf: 'http://example.com/collection',
        rootCollection: 'http://example.com/root',
        metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      };

      expect(result).toEqual(expectedBaseEntity);
    });
  });

  describe('Custom transformers', () => {
    it('should allow custom transformer to add computed fields', () => {
      const customTransformer: EntityTransformer<AuthorisedEntity, { id: string; displayName: string; uri: string }> = (
        entity,
      ) => ({
        id: entity.id,
        displayName: entity.name.toUpperCase(),
        uri: entity.id,
      });

      const result = customTransformer(mockAuthorisedEntity, mockContext, mockRow);

      expect(result).toEqual({
        id: 'http://example.com/entity/123',
        displayName: 'TEST ENTITY',
        uri: 'http://example.com/entity/123',
      });
    });

    it('should support async transformers for fetching related data', async () => {
      const asyncTransformer: EntityTransformer<
        AuthorisedEntity,
        { id: string; name: string; relatedData: string }
      > = async (entity) => {
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 1));

        return {
          id: entity.id,
          name: entity.name,
          relatedData: 'fetched-data',
        };
      };

      const result = await asyncTransformer(mockAuthorisedEntity, mockContext, mockRow);

      expect(result).toEqual({
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        relatedData: 'fetched-data',
      });
    });

    it('should allow transformer to access context', async () => {
      const contextAwareTransformer: EntityTransformer<
        AuthorisedEntity,
        {
          id: string;
          name: string;
          requestUrl: string;
        }
      > = async (entity, context) => ({
        id: entity.id,
        name: entity.name,
        requestUrl: context.request.url || 'unknown',
      });

      const contextWithUrl: RequestContext = {
        request: { url: '/test-url' } as FastifyRequest,
        fastify: {} as FastifyInstance,
      };

      const result = await contextAwareTransformer(mockAuthorisedEntity, contextWithUrl, mockRow);

      expect(result).toEqual({
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        requestUrl: '/test-url',
      });
    });

    it('should support transformer pipeline', async () => {
      const addDisplayName: EntityTransformer<AuthorisedEntity, AuthorisedEntity & { displayName: string }> = (
        entity,
      ) => ({
        ...entity,
        displayName: `${entity.name} [${entity.entityType.split('/').pop()}]`,
      });

      const addUpperCase: EntityTransformer<
        AuthorisedEntity & { displayName: string },
        AuthorisedEntity & { displayName: string; upperName: string }
      > = (entity) => ({
        ...entity,
        upperName: entity.name.toUpperCase(),
      });

      // Simulate pipeline
      // biome-ignore lint/suspicious/noExplicitAny: fine in tests
      let result: any = mockAuthorisedEntity;
      result = await addDisplayName(result, mockContext, mockRow);
      result = await addUpperCase(result, mockContext, mockRow);

      expect(result).toMatchObject({
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        displayName: 'Test Entity [Person]',
        upperName: 'TEST ENTITY',
      });
    });

    it('should demonstrate full pipeline: base -> resolve -> access -> custom', async () => {
      const rawEntity = {
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        description: 'A test entity',
        entityType: 'http://schema.org/Person',

        memberOf: 'http://example.com/collection',
        rootCollection: 'http://example.com/root',
        metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
        meta: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const access: AccessFunction = () => ({
        metadata: true,
        content: false,
        contentAuthorizationUrl: 'https://example.com/auth',
      });

      const addMetadata: EntityTransformer<AuthorisedEntity, AuthorisedEntity & { processed: boolean }> = (entity) => ({
        ...entity,
        processed: true,
      });

      prisma.entity.findMany.mockResolvedValue([
        { ...rawEntity, id: 'http://example.com/collection', name: 'Parent Collection' },
        { ...rawEntity, id: 'http://example.com/root', name: 'Root Collection' },
      ]);

      const [authorised] = await authoriseEntities([rawEntity], prisma, access, mockContext);
      const final = await applyTransformers(authorised, [addMetadata], mockContext, rawEntity);

      expect(final).toMatchObject({
        id: 'http://example.com/entity/123',
        name: 'Test Entity',
        memberOf: { id: 'http://example.com/collection', name: 'Parent Collection' },
        rootCollection: { id: 'http://example.com/root', name: 'Root Collection' },
        access: {
          metadata: true,
          content: false,
          contentAuthorizationUrl: 'https://example.com/auth',
        },
        processed: true,
      });
    });
  });
});
