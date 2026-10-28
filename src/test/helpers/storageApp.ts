import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import type { Options } from '../../app.js';
import app, { AllPublicAccess, AllVisibleEntityFilter, AllVisibleSearchFilter } from '../../app.js';
import type { AccessFunction } from '../../types/access.js';
import { fakeSearchBackend } from './fakeSearchBackend.js';
import { prisma } from './fastify.js';

/**
 * The plugin over the mocked Prisma client, with `storage` and a log of every error it writes
 * `configure` runs on an encapsulated scope, before the plugin is registered in it
 */
export const buildStorageApp = async (storage: Options['storage'], configure?: (instance: FastifyInstance) => void) => {
  type LogLine = { err?: { message: string } };
  const errors: LogLine[] = [];
  const stream = new Writable({
    write: (chunk, _encoding, done) => {
      errors.push(JSON.parse(chunk.toString()) as LogLine);
      done();
    },
  });
  const access = vi.fn<AccessFunction>(AllPublicAccess);

  const instance = Fastify({ logger: { level: 'error', stream } });
  await instance.register(async (scope) => {
    configure?.(scope);
    await scope.register(app, {
      prisma,
      search: fakeSearchBackend().backend,
      access,
      entityVisibilityFilter: AllVisibleEntityFilter,
      searchVisibilityFilter: AllVisibleSearchFilter,
      storage,
    });
  });
  await instance.ready();

  return { app: instance, access, errors };
};
