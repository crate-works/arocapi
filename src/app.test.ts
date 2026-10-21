import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReset } from 'vitest-mock-extended';

import type { Options } from './app.js';
import app, { AllPublicAccess, AllVisibleEntityFilter, AllVisibleSearchFilter } from './app.js';

import { fakeSearchBackend } from './test/helpers/fakeSearchBackend.js';
import { prisma } from './test/helpers/fastify.js';

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
});
