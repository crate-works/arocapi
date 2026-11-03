import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { applyTransformers, authoriseEntities, toEntityRow } from '../transformers/default.js';
import type { AccessFunction } from '../types/access.js';
import type { EntityTransformer } from '../types/transformers.js';
import type { EntityVisibilityFilter } from '../types/visibility.js';
import { createEntityNotVisibleResponder, type RefusalOptions } from '../utils/visibility.js';

const paramsSchema = z.object({
  id: z.url(),
});

type EntityRouteOptions = {
  prisma: PrismaClient;
  access: AccessFunction;
  entityTransformers?: EntityTransformer[];
  entityVisibilityFilter: EntityVisibilityFilter;
  refusal: RefusalOptions;
};

const entity: FastifyPluginAsync<EntityRouteOptions> = async (fastify, opts) => {
  const { prisma, access, entityTransformers = [], entityVisibilityFilter, refusal } = opts;
  const sendEntityNotVisible = createEntityNotVisibleResponder(prisma, refusal);

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/entity/:id',
    {
      schema: {
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const context = { request, fastify };
      const visibilityWhere = await entityVisibilityFilter(context);
      const entity = await prisma.entity.findFirst({
        where: { AND: [{ id }, visibilityWhere] },
        include: { file: { select: { id: true } } },
      });

      if (!entity) {
        return sendEntityNotVisible(reply, id, context);
      }

      const [authorisedEntity] = await authoriseEntities([entity], prisma, access, context);

      return applyTransformers(authorisedEntity, entityTransformers, context, toEntityRow(entity));
    },
  );
};

export default entity;
