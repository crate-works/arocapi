import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccessFunction, EntityRow, FileRow, FileTransformer } from '../app.js';
import { fastify, fastifyAfter, fastifyBefore, prisma } from '../test/helpers/fastify.js';
import { recordRows, restrictedByMeta } from '../test/helpers/rows.js';
import { AllPublicAccess } from '../utils/access.js';
import type { StandardErrorResponse } from '../utils/errors.js';
import { AllVisibleEntityFilter } from '../utils/visibility.js';
import filesRoute from './files.js';

describe('Files Route', () => {
  const mockEntity = (id: string, name: string) => ({
    id,
    name,
    description: '',
    entityType: 'http://schema.org/MediaObject',
    memberOf: null,
    rootCollection: null,
    metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
    contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
    meta: {},
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  });

  beforeEach(async () => {
    await fastifyBefore();
    await fastify.register(filesRoute, {
      entityVisibilityFilter: AllVisibleEntityFilter,
      prisma,
      access: AllPublicAccess,
    });
  });

  afterEach(async () => {
    await fastifyAfter();
  });

  const mockFile1 = {
    id: 'http://example.com/file1.wav',
    filename: 'file1.wav',
    mediaType: 'audio/wav',
    size: BigInt(1024),
    meta: {},
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    entity: mockEntity('http://example.com/file1.wav', 'file1.wav'),
  };

  const mockFile2 = {
    id: 'http://example.com/file2.txt',
    filename: 'file2.txt',
    mediaType: 'text/plain',
    size: BigInt(512),
    meta: {},
    createdAt: new Date('2025-01-02'),
    updatedAt: new Date('2025-01-02'),
    entity: mockEntity('http://example.com/file2.txt', 'file2.txt'),
  };

  describe('GET /files', () => {
    it('should list all files successfully', async () => {
      prisma.file.findMany.mockResolvedValue([mockFile1, mockFile2]);
      prisma.file.count.mockResolvedValue(2);

      const response = await fastify.inject({
        method: 'GET',
        url: '/files',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { total: number; files: unknown[] };
      expect(body.total).toBe(2);
      expect(body.files).toHaveLength(2);
      expect(body.files[0]).toMatchObject({
        id: 'http://example.com/file1.wav',
        filename: 'file1.wav',
        mediaType: 'audio/wav',
        size: 1024,
        access: {
          content: true,
        },
      });
      expect(prisma.file.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: { entity: true } }));
    });

    it('should filter files by memberOf', async () => {
      prisma.file.findMany.mockResolvedValue([mockFile1]);
      prisma.file.count.mockResolvedValue(1);

      const response = await fastify.inject({
        method: 'GET',
        url: '/files?memberOf=http://example.com/collection/1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { total: number; files: unknown[] };
      expect(body.total).toBe(1);
      expect(body.files).toHaveLength(1);
      expect(body.files[0]).toMatchObject({
        id: 'http://example.com/file1.wav',
        filename: 'file1.wav',
      });
      expect(prisma.file.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { entity: { AND: [{ memberOf: 'http://example.com/collection/1' }, {}] } },
        }),
      );
    });

    it('should support pagination with limit and offset', async () => {
      prisma.file.findMany.mockResolvedValue([mockFile2]);
      prisma.file.count.mockResolvedValue(2);

      const response = await fastify.inject({
        method: 'GET',
        url: '/files?limit=1&offset=1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { total: number; files: unknown[] };
      expect(body.total).toBe(2);
      expect(body.files).toHaveLength(1);
      expect(prisma.file.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 1,
          take: 1,
        }),
      );
    });

    it('should support sorting by filename ascending', async () => {
      prisma.file.findMany.mockResolvedValue([mockFile1, mockFile2]);
      prisma.file.count.mockResolvedValue(2);

      const response = await fastify.inject({
        method: 'GET',
        url: '/files?sort=filename&order=asc',
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.file.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { filename: 'asc' },
        }),
      );
    });

    it('should support sorting by id directly', async () => {
      prisma.file.findMany.mockResolvedValue([mockFile1, mockFile2]);
      prisma.file.count.mockResolvedValue(2);

      const response = await fastify.inject({
        method: 'GET',
        url: '/files?sort=id&order=desc',
      });

      expect(response.statusCode).toBe(200);
      expect(prisma.file.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { id: 'desc' },
        }),
      );
    });

    it('should return empty list when no files found', async () => {
      prisma.file.findMany.mockResolvedValue([]);
      prisma.file.count.mockResolvedValue(0);

      const response = await fastify.inject({
        method: 'GET',
        url: '/files',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { total: number; files: unknown[] };
      expect(body.total).toBe(0);
      expect(body.files).toHaveLength(0);
    });

    it('should return 500 when database error occurs', async () => {
      prisma.file.findMany.mockRejectedValue(new Error('Database connection failed'));

      const response = await fastify.inject({
        method: 'GET',
        url: '/files',
      });
      const body = JSON.parse(response.body) as { error: { code: string } };

      expect(response.statusCode).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });

    it('should validate limit parameter', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/files?limit=2000',
      });
      const body = JSON.parse(response.body) as StandardErrorResponse;

      expect(response.statusCode).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should validate memberOf parameter format', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/files?memberOf=invalid-url',
      });
      const body = JSON.parse(response.body) as StandardErrorResponse;

      expect(response.statusCode).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should validate sort parameter', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/files?sort=invalid',
      });
      const body = JSON.parse(response.body) as StandardErrorResponse;

      expect(response.statusCode).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Custom File Transformers', () => {
    it('should apply custom file transformers', async () => {
      await fastifyBefore();

      // Custom transformer that adds extra fields
      const customTransformer: FileTransformer = (file) => ({
        ...file,
        customField: 'test-value',
        uppercaseFilename: file.filename.toUpperCase(),
      });

      await fastify.register(filesRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        prisma,
        access: AllPublicAccess,
        fileTransformers: [customTransformer],
      });

      prisma.file.findMany.mockResolvedValue([mockFile1]);
      prisma.file.count.mockResolvedValue(1);

      const response = await fastify.inject({
        method: 'GET',
        url: '/files',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { files: unknown[] };
      expect(body.files[0]).toMatchObject({
        id: 'http://example.com/file1.wav',
        filename: 'file1.wav',
        customField: 'test-value',
        uppercaseFilename: 'FILE1.WAV',
      });

      await fastifyAfter();
    });

    it("decides access with each file entity's row without sending it", async () => {
      await fastifyBefore();
      const rows: EntityRow[] = [];
      await fastify.register(filesRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        prisma,
        access: restrictedByMeta(rows),
      });
      const restricted = { ...mockFile1.entity, meta: { accessControl: 'Restricted' } };
      prisma.file.findMany.mockResolvedValue([{ ...mockFile1, entity: restricted }, mockFile2]);
      prisma.file.count.mockResolvedValue(2);

      const response = await fastify.inject({ method: 'GET', url: '/files' });

      expect(response.statusCode).toBe(200);
      expect(rows).toEqual([restricted, mockFile2.entity]);
      const { files } = response.json<{ files: Array<{ access: unknown }> }>();
      expect(files.map((file) => file.access)).toEqual([{ content: false }, { content: true }]);
      for (const file of files) {
        expect(file).not.toHaveProperty('meta');
        expect(file).not.toHaveProperty('entity');
      }

      await fastifyAfter();
    });

    it('gives file transformers each file row with its entity row without sending it', async () => {
      await fastifyBefore();
      const rows: FileRow[] = [];
      await fastify.register(filesRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        prisma,
        access: AllPublicAccess,
        fileTransformers: [recordRows(rows)],
      });
      const loaded = [
        {
          ...mockFile1,
          meta: { checksum: 'abc' },
          entity: { ...mockFile1.entity, meta: { accessControl: 'Restricted' } },
        },
        mockFile2,
      ];
      prisma.file.findMany.mockResolvedValue(loaded);
      prisma.file.count.mockResolvedValue(2);

      const response = await fastify.inject({ method: 'GET', url: '/files' });

      expect(response.statusCode).toBe(200);
      expect(rows).toEqual(loaded);
      for (const file of response.json<{ files: unknown[] }>().files) {
        expect(file).not.toHaveProperty('meta');
        expect(file).not.toHaveProperty('entity');
        expect(file).not.toHaveProperty('createdAt');
      }

      await fastifyAfter();
    });

    it('should attach the content access of each file entity', async () => {
      await fastifyBefore();

      const access: AccessFunction = (entity) =>
        entity.id === 'http://example.com/file1.wav'
          ? {
              metadata: false,
              content: false,
              metadataAuthorizationUrl: 'https://example.com/request-metadata',
              contentAuthorizationUrl: 'https://example.com/request-access',
            }
          : { metadata: true, content: true };

      await fastify.register(filesRoute, {
        entityVisibilityFilter: AllVisibleEntityFilter,
        prisma,
        access,
      });

      prisma.file.findMany.mockResolvedValue([mockFile1, mockFile2]);
      prisma.file.count.mockResolvedValue(2);

      const response = await fastify.inject({
        method: 'GET',
        url: '/files',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { files: Array<{ access: unknown }> };
      expect(body.files[0].access).toEqual({
        content: false,
        contentAuthorizationUrl: 'https://example.com/request-access',
      });
      expect(body.files[1].access).toEqual({ content: true });

      await fastifyAfter();
    });
  });
});
