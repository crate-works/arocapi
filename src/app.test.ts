import Fastify from 'fastify';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mockReset } from 'vitest-mock-extended';

import type { Options } from './app.js';
import app, { AllPublicAccess, AllVisibleEntityFilter, AllVisibleSearchFilter } from './app.js';

import { fakeSearchBackend } from './test/helpers/fakeSearchBackend.js';
import { prisma } from './test/helpers/fastify.js';
import { entityRow } from './test/helpers/rows.js';

describe('Entity Route', () => {
  beforeEach(() => {
    mockReset(prisma);
  });

  const requiredOptions = (): Options => ({
    prisma,
    search: fakeSearchBackend().backend,
    access: AllPublicAccess,
    storage: { metadata: vi.fn(), content: vi.fn() },
    entityVisibilityFilter: AllVisibleEntityFilter,
    searchVisibilityFilter: AllVisibleSearchFilter,
  });

  describe('App Registration', () => {
    it.each([
      ['prisma', 'Prisma client is required'],
      ['search', 'search is required'],
      ['access', 'access is required'],
      ['storage', 'storage is required'],
      ['entityVisibilityFilter', 'entityVisibilityFilter is required'],
      ['searchVisibilityFilter', 'searchVisibilityFilter is required'],
    ] as const)('should handle missing %s', async (option, message) => {
      const fastify = Fastify({ logger: false });
      const { [option]: _omitted, ...options } = requiredOptions();

      // @ts-expect-error we are testing missing options
      fastify.register(app, options);

      await expect(() => fastify.ready()).rejects.toThrowError(message);
    });

    it.each(['metadata', 'content'] as const)('should require storage.%s', async (half) => {
      const fastify = Fastify({ logger: false });
      const { [half]: _omitted, ...storage } = requiredOptions().storage;

      // @ts-expect-error we are testing a missing half
      fastify.register(app, { ...requiredOptions(), storage });

      await expect(() => fastify.ready()).rejects.toThrowError(`storage.${half} is required`);
    });

    it.each([
      ['accessTransformer', 'access', 'https://arocapi.crate-works.org/configuration/access/'],
      ['fileAccessTransformer', 'access', 'https://arocapi.crate-works.org/configuration/access/'],
      [
        'hiddenResponse',
        'promptLoginForHidden and isAuthenticated',
        'https://arocapi.crate-works.org/configuration/visibility/#promptloginforhidden',
      ],
    ])('should reject the removed %s option', async (option, replacement, docs) => {
      const fastify = Fastify({ logger: false });

      fastify.register(app, { ...requiredOptions(), [option]: 'notFound' });

      await expect(() => fastify.ready()).rejects.toThrowError(
        `${option} has been replaced by ${replacement}, see ${docs}`,
      );
    });

    it.each([
      ['an object without the arocapi models', { $connect: vi.fn() }],
      ['a Prisma 8 client', { orm: { public: { Entity: {} } }, raw: {} }],
      ['a client missing the file model', { entity: { findMany: vi.fn() } }],
    ])('should reject %s as prisma', async (_label, client) => {
      const fastify = Fastify({ logger: false });

      fastify.register(app, { ...requiredOptions(), prisma: client as unknown as Options['prisma'] });

      await expect(() => fastify.ready()).rejects.toThrowError(
        'prisma must be a Prisma 7 client generated from a schema that includes the arocapi models',
      );
    });

    it('should reject promptLoginForHidden without isAuthenticated', async () => {
      const fastify = Fastify({ logger: false });

      fastify.register(app, { ...requiredOptions(), promptLoginForHidden: true });

      await expect(() => fastify.ready()).rejects.toThrowError('promptLoginForHidden requires isAuthenticated');
    });

    it('should ignore a removed option left undefined', async () => {
      const fastify = Fastify({ logger: false });

      await fastify.register(app, { ...requiredOptions(), accessTransformer: undefined } as Options);

      await expect(fastify.ready()).resolves.toBeDefined();

      await fastify.close();
    });

    it('should register successfully with all required options', async () => {
      const fastify = Fastify({ logger: false });

      await fastify.register(app, requiredOptions());

      await expect(fastify.ready()).resolves.toBeDefined();

      await fastify.close();
    });
  });

  describe('Cache-Control', () => {
    const id = 'http://example.com/entity/123';

    const build = async (options: Partial<Options> = {}) => {
      const fastify = Fastify({ logger: false });
      await fastify.register(app, { ...requiredOptions(), ...options });
      onTestFinished(() => fastify.close());

      return fastify;
    };

    beforeEach(() => {
      prisma.entity.findFirst.mockResolvedValue(entityRow({ id }));
      prisma.entity.findMany.mockResolvedValue([]);
      prisma.entity.count.mockResolvedValue(0);
      prisma.file.findMany.mockResolvedValue([]);
      prisma.file.count.mockResolvedValue(0);
    });

    it.each([
      ['a Record', 'GET', `/entity/${encodeURIComponent(id)}`, undefined, 200],
      ['an invalid entity id', 'GET', '/entity/invalid-id', undefined, 400],
      ['a listing of entities', 'GET', '/entities', undefined, 200],
      ['an invalid listing of entities', 'GET', '/entities?limit=0', undefined, 400],
      ['a listing of files', 'GET', '/files', undefined, 200],
      ['an invalid listing of files', 'GET', '/files?limit=2000', undefined, 400],
      ['a search', 'POST', '/search', { query: 'test' }, 200],
      ['an invalid search', 'POST', '/search', { sort: 'createdAt' }, 400],
    ] as const)('marks %s private', async (_, method, url, payload, status) => {
      const fastify = await build();

      const response = await fastify.inject({ method, url, payload });

      expect([response.statusCode, response.headers['cache-control']]).toEqual([status, 'private']);
    });

    it('marks an entity that is not visible private', async () => {
      prisma.entity.findFirst.mockResolvedValue(null);
      const fastify = await build();

      const response = await fastify.inject({ method: 'GET', url: `/entity/${encodeURIComponent(id)}` });

      expect([response.statusCode, response.headers['cache-control']]).toEqual([404, 'private']);
    });

    it('marks an unknown path under its prefix private', async () => {
      const fastify = Fastify({ logger: false });
      await fastify.register(app, { ...requiredOptions(), prefix: '/api' } as Options);
      onTestFinished(() => fastify.close());

      const response = await fastify.inject({ method: 'GET', url: '/api/unknown' });

      expect([response.statusCode, response.headers['cache-control']]).toEqual([404, 'private']);
    });

    it("leaves an app's own Cache-Control on /capabilities alone", async () => {
      const fastify = Fastify({ logger: false });
      fastify.addHook('onRequest', async (_request, reply) => {
        reply.header('Cache-Control', 'public, max-age=60');
      });
      await fastify.register(app, requiredOptions());
      onTestFinished(() => fastify.close());

      const response = await fastify.inject({ method: 'GET', url: '/capabilities' });

      expect(response.headers['cache-control']).toBe('public, max-age=60');
    });

    it("leaves the app's own routes alone", async () => {
      const fastify = Fastify({ logger: false });
      fastify.get('/health', async () => 'ok');
      await fastify.register(app, requiredOptions());
      onTestFinished(() => fastify.close());

      const response = await fastify.inject({ method: 'GET', url: '/health' });

      expect([response.statusCode, response.headers['cache-control']]).toEqual([200, undefined]);
    });

    it('sends none on /capabilities, as it is the same for every user', async () => {
      const fastify = await build();

      const response = await fastify.inject({ method: 'GET', url: '/capabilities' });

      expect([response.statusCode, response.headers['cache-control']]).toEqual([200, undefined]);
    });
  });
});
