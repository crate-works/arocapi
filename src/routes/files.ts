import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { applyTransformers, authoriseFiles } from '../transformers/default.js';
import type { AccessFunction } from '../types/access.js';
import type { FileTransformer } from '../types/transformers.js';
import type { EntityVisibilityFilter } from '../types/visibility.js';

const querySchema = z.object({
  memberOf: z.url().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['id', 'filename', 'createdAt', 'updatedAt']).default('id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

type FilesRouteOptions = {
  prisma: PrismaClient;
  access: AccessFunction;
  fileTransformers?: FileTransformer[];
  entityVisibilityFilter: EntityVisibilityFilter;
};

const files: FastifyPluginAsync<FilesRouteOptions> = async (fastify, opts) => {
  const { prisma, access, fileTransformers = [], entityVisibilityFilter } = opts;

  fastify.withTypeProvider<ZodTypeProvider>().get(
    '/files',
    {
      schema: {
        querystring: querySchema,
      },
    },
    async (request) => {
      const { memberOf, limit, offset, sort, order } = request.query;

      const context = { request, fastify };
      const visibilityWhere = await entityVisibilityFilter(context);
      const where = { entity: { AND: [{ memberOf }, visibilityWhere] } };

      const [dbFiles, total] = await Promise.all([
        prisma.file.findMany({
          where,
          include: { entity: true },
          orderBy: {
            [sort]: order,
          },
          skip: offset,
          take: limit,
        }),
        prisma.file.count({ where }),
      ]);

      const authorisedFiles = await authoriseFiles(dbFiles, access, context);
      const filesWithAccess = await Promise.all(
        authorisedFiles.map((file) => applyTransformers(file, fileTransformers, context)),
      );

      return {
        total,
        files: filesWithAccess,
      };
    },
  );
};

export default files;
