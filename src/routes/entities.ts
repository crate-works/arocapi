import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { applyTransformers, authoriseEntities } from '../transformers/default.js';
import type { AccessFunction } from '../types/access.js';
import type { EntityTransformer } from '../types/transformers.js';
import type { EntityVisibilityFilter } from '../types/visibility.js';

const querySchema = z.object({
  memberOf: z.url().optional(),
  entityType: z
    .union([z.string(), z.array(z.string())])
    .default([])
    .transform((val) =>
      [val]
        .flat()
        .map((value) => value.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url())),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['id', 'name', 'createdAt', 'updatedAt']).default('id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

type EntitiesRouteOptions = {
  prisma: PrismaClient;
  access: AccessFunction;
  entityTransformers?: EntityTransformer[];
  entityVisibilityFilter: EntityVisibilityFilter;
};

const entities: FastifyPluginAsync<EntitiesRouteOptions> = async (fastify, opts) => {
  const { prisma, access, entityTransformers = [], entityVisibilityFilter } = opts;
  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/entities',
    {
      schema: {
        querystring: querySchema,
      },
    },
    async (request) => {
      const { memberOf, entityType, limit, offset, sort, order } = request.query;

      const where: NonNullable<Parameters<typeof prisma.entity.findMany>[0]>['where'] = {};

      if (memberOf) {
        where.memberOf = memberOf;
      }

      if (entityType.length > 0) {
        where.entityType = {
          in: entityType,
        };
      }

      const context = { request, fastify };
      const visibilityWhere = await entityVisibilityFilter(context);
      const visibleWhere = { AND: [where, visibilityWhere] };

      const [dbEntities, total] = await Promise.all([
        prisma.entity.findMany({
          where: visibleWhere,
          orderBy: {
            [sort]: order,
          },
          skip: offset,
          take: limit,
        }),
        prisma.entity.count({ where: visibleWhere }),
      ]);

      const authorisedEntities = await authoriseEntities(dbEntities, prisma, access, context);
      const entities = await Promise.all(
        authorisedEntities.map((entity, i) => applyTransformers(entity, entityTransformers, context, dbEntities[i])),
      );

      return {
        total,
        entities,
      };
    },
  );
};

export default entities;
