import type { FastifyInstance, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import type { Entity } from '../generated/prisma/client.js';
import { prisma } from '../test/helpers/fastify.js';
import type { AccessFunction } from '../types/access.js';
import type { RequestContext } from '../types/context.js';
import { AllPublicAccess } from '../utils/access.js';
import { applyTransformers, authoriseEntities, authoriseFiles, baseEntityTransformer } from './default.js';

const context: RequestContext = {
  request: {} as FastifyRequest,
  fastify: {} as FastifyInstance,
};

describe('baseEntityTransformer', () => {
  it('should transform entity to standard entity shape', () => {
    const entity: Entity & { file?: { id: string } | null } = {
      id: 'http://example.com/entity/123',
      name: 'Test Entity',
      description: 'A test entity description',
      entityType: 'http://pcdm.org/models#Collection',
      memberOf: 'http://example.com/parent',
      rootCollection: 'http://example.com/root',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by-sa/4.0/',
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-02'),
      meta: { test: 'data' },
    };

    const result = baseEntityTransformer(entity);

    expect(result).toEqual({
      id: 'http://example.com/entity/123',
      name: 'Test Entity',
      description: 'A test entity description',
      entityType: 'http://pcdm.org/models#Collection',
      memberOf: 'http://example.com/parent',
      rootCollection: 'http://example.com/root',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by-sa/4.0/',
    });
  });

  it('should handle null memberOf and rootCollection', () => {
    const entity: Entity & { file?: { id: string } | null } = {
      id: 'http://example.com/collection',
      name: 'Top Collection',
      description: 'A top-level collection',
      entityType: 'http://pcdm.org/models#Collection',
      memberOf: null,
      rootCollection: null,
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      createdAt: new Date(),
      updatedAt: new Date(),
      meta: null,
    };

    const result = baseEntityTransformer(entity);

    expect(result.memberOf).toBeNull();
    expect(result.rootCollection).toBeNull();
  });

  it('should exclude database-specific fields', () => {
    const entity: Entity & { file?: { id: string } | null } = {
      id: 'http://example.com/entity/456',
      name: 'Test',
      description: 'Test',
      entityType: 'http://pcdm.org/models#Object',
      memberOf: null,
      rootCollection: null,
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      createdAt: new Date(),
      updatedAt: new Date(),
      meta: { storage: 'path' },
    };

    const result = baseEntityTransformer(entity);

    expect(result.id).toBe('http://example.com/entity/456');
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
    expect(result).not.toHaveProperty('meta');
    expect(Object.keys(result)).toEqual([
      'id',
      'name',
      'description',
      'entityType',
      'memberOf',
      'rootCollection',
      'metadataLicenseId',
      'contentLicenseId',
    ]);
  });

  it('should handle File entity (MediaObject) with file relation', () => {
    const entity: Entity & { file?: { id: string } | null } = {
      id: 'http://example.com/file/audio.wav',
      name: 'Audio File',
      description: 'An audio recording',
      entityType: 'http://schema.org/MediaObject',
      memberOf: 'http://example.com/collection',
      rootCollection: 'http://example.com/collection',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      createdAt: new Date(),
      updatedAt: new Date(),
      meta: null,
      file: { id: 'http://example.com/files/audio.wav' },
    };

    const result = baseEntityTransformer(entity);

    expect(result).toEqual({
      id: 'http://example.com/file/audio.wav',
      name: 'Audio File',
      description: 'An audio recording',
      entityType: 'http://schema.org/MediaObject',
      memberOf: 'http://example.com/collection',
      rootCollection: 'http://example.com/collection',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
    });
  });
});

describe('AllPublicAccess', () => {
  it('should grant access to metadata and content without authorisation URLs', () => {
    const baseEntity = {
      id: 'http://example.com/entity/123',
      name: 'Test Entity',
      description: 'A test entity',
      entityType: 'http://schema.org/MediaObject',
      memberOf: 'http://example.com/parent',
      rootCollection: 'http://example.com/root',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
    };

    expect(AllPublicAccess(baseEntity, context, dbEntity(baseEntity.id))).toEqual({ metadata: true, content: true });
  });
});

const dbEntity = (id: string, overrides: Partial<Entity> = {}): Entity => ({
  id,
  name: `Name of ${id}`,
  description: '',
  entityType: 'http://schema.org/MediaObject',
  memberOf: null,
  rootCollection: null,
  metadataLicenseId: 'https://example.com/licence/metadata',
  contentLicenseId: 'https://example.com/licence/content',
  createdAt: new Date(),
  updatedAt: new Date(),
  meta: null,
  ...overrides,
});

describe('authoriseEntities', () => {
  beforeEach(() => {
    mockReset(prisma);
  });

  it('should pass the access function parent ids but return the Record with parent names', async () => {
    prisma.entity.findMany.mockResolvedValue([dbEntity('http://example.com/collection')]);
    const access = vi.fn<AccessFunction>(AllPublicAccess);

    const [entity] = await authoriseEntities(
      [dbEntity('http://example.com/item', { memberOf: 'http://example.com/collection' })],
      prisma,
      access,
      context,
    );

    expect(access).toHaveBeenCalledWith(
      expect.objectContaining({ memberOf: 'http://example.com/collection' }),
      context,
      expect.objectContaining({ memberOf: 'http://example.com/collection' }),
    );
    expect(entity.memberOf).toEqual({
      id: 'http://example.com/collection',
      name: 'Name of http://example.com/collection',
    });
    expect(entity.access).toEqual({ metadata: true, content: true });
  });

  it('should keep only the access keys the library defines', async () => {
    const access = vi.fn(async () => ({
      metadata: false,
      content: false,
      metadataAuthorizationUrl: 'https://example.com/request-metadata',
      contentAuthorizationUrl: 'https://example.com/request-content',
      licence: 'secret',
    }));

    const [entity] = await authoriseEntities([dbEntity('http://example.com/item')], prisma, access, context);

    expect(entity.access).toEqual({
      metadata: false,
      content: false,
      metadataAuthorizationUrl: 'https://example.com/request-metadata',
      contentAuthorizationUrl: 'https://example.com/request-content',
    });
  });
});

describe('authoriseFiles', () => {
  beforeEach(() => {
    mockReset(prisma);
  });

  const dbFile = (id: string) => ({
    id,
    filename: 'audio.wav',
    mediaType: 'audio/wav',
    size: BigInt(2048),
    meta: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    entity: dbEntity(id),
  });

  it("should attach only the Content access of each file's entity", async () => {
    const access: AccessFunction = (entity) =>
      entity.id === 'http://example.com/restricted.wav'
        ? {
            metadata: false,
            content: false,
            metadataAuthorizationUrl: 'https://example.com/request-metadata',
            contentAuthorizationUrl: 'https://example.com/request-content',
          }
        : { metadata: false, content: true };

    const files = await authoriseFiles(
      [dbFile('http://example.com/restricted.wav'), dbFile('http://example.com/open.wav')],
      access,
      context,
    );

    expect(files).toEqual([
      {
        id: 'http://example.com/restricted.wav',
        filename: 'audio.wav',
        mediaType: 'audio/wav',
        size: 2048,
        access: { content: false, contentAuthorizationUrl: 'https://example.com/request-content' },
      },
      {
        id: 'http://example.com/open.wav',
        filename: 'audio.wav',
        mediaType: 'audio/wav',
        size: 2048,
        access: { content: true },
      },
    ]);
  });
});

describe('applyTransformers', () => {
  it('should chain transformers in order', async () => {
    const result = await applyTransformers(
      'a',
      [(item) => `${item}b`, async (item, { request }) => `${item}c${request.url}`],
      { ...context, request: { url: '/d' } as FastifyRequest },
    );

    expect(result).toBe('abc/d');
  });

  it('should return the item unchanged without transformers', async () => {
    expect(await applyTransformers('a', [], context)).toBe('a');
  });
});
