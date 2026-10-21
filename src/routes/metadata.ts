import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { MetadataSource } from '../storage/backend.js';
import { sendDelivery } from '../storage/deliver.js';
import type { AccessFunction } from '../types/access.js';
import type { EntityVisibilityFilter } from '../types/visibility.js';
import { createAccessGuard } from '../utils/access.js';
import { createNotFoundError } from '../utils/errors.js';
import { createEntityNotVisibleResponder, type RefusalOptions } from '../utils/visibility.js';

const paramsSchema = z.object({
  id: z.url(),
});

type MetadataRouteOptions = {
  prisma: PrismaClient;
  metadata: MetadataSource;
  access: AccessFunction;
  entityVisibilityFilter: EntityVisibilityFilter;
  refusal: RefusalOptions;
};

const metadataRoute: FastifyPluginAsync<MetadataRouteOptions> = async (fastify, opts) => {
  const { prisma, metadata, access, entityVisibilityFilter, refusal } = opts;

  const sendEntityNotVisible = createEntityNotVisibleResponder(prisma, refusal);
  const denyMetadata = createAccessGuard({ access, isAuthenticated: refusal.isAuthenticated, level: 'metadata' });

  fastify.withTypeProvider<ZodTypeProvider>().route({
    method: ['GET', 'HEAD'],
    url: '/entity/:id/metadata',
    schema: {
      params: paramsSchema,
    },
    handler: async (request, reply) => {
      const { id } = request.params;

      const context = { request, fastify };
      const entity = await prisma.entity.findFirst({ where: { AND: [{ id }, await entityVisibilityFilter(context)] } });

      if (!entity) {
        return sendEntityNotVisible(reply, id, context);
      }

      if (await denyMetadata(reply, entity, context)) {
        return reply;
      }

      const delivery = await metadata(entity, context);

      if (!delivery) {
        return reply.code(404).send(createNotFoundError('The requested RO-Crate metadata was not found', id));
      }

      return sendDelivery(request, reply, delivery, { contentType: 'application/ld+json' });
    },
  });
};

export default metadataRoute;
