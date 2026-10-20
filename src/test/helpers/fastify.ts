import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { mockDeep, mockReset } from 'vitest-mock-extended';

import type { PrismaClient } from '../../generated/prisma/client.js';
import { setupValidation } from '../../utils/validation.js';

export let fastify: FastifyInstance;
export const prisma = mockDeep<PrismaClient>();

export const fastifyBefore = async () => {
  mockReset(prisma);

  fastify = Fastify({ logger: false });

  setupValidation(fastify);

  return fastify;
};

export const fastifyAfter = async () => {
  await fastify.close();
};
