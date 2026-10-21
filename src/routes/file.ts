import { create as contentDisposition } from 'content-disposition';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ContentSource } from '../storage/backend.js';
import { sendDelivery } from '../storage/deliver.js';
import type { AccessFunction } from '../types/access.js';
import type { EntityVisibilityFilter } from '../types/visibility.js';
import { createAccessGuard } from '../utils/access.js';
import { createNotFoundError } from '../utils/errors.js';
import { createNotVisibleResponder, type RefusalOptions } from '../utils/visibility.js';

const paramsSchema = z.object({
  id: z.url(),
});

const querySchema = z.object({
  disposition: z.enum(['inline', 'attachment']).optional().default('inline'),
  filename: z.string().optional(),
  noRedirect: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true'),
});

type FileRouteOptions = {
  prisma: PrismaClient;
  content: ContentSource;
  access: AccessFunction;
  entityVisibilityFilter: EntityVisibilityFilter;
  refusal: RefusalOptions;
};

const file: FastifyPluginAsync<FileRouteOptions> = async (fastify, opts) => {
  const { prisma, content, access, entityVisibilityFilter, refusal } = opts;

  const denyContent = createAccessGuard({ access, isAuthenticated: refusal.isAuthenticated, level: 'content' });

  const sendFileNotVisible = createNotVisibleResponder({
    ...refusal,
    notFoundMessage: 'The requested file was not found',
    exists: async (id) => (await prisma.file.count({ where: { id } })) > 0,
  });

  fastify.withTypeProvider<ZodTypeProvider>().route({
    method: ['GET', 'HEAD'],
    url: '/file/:id',
    schema: {
      params: paramsSchema,
      querystring: querySchema,
    },
    handler: async (request, reply) => {
      const { id } = request.params;

      const context = { request, fastify };
      const found = await prisma.file.findFirst({
        where: { id, entity: await entityVisibilityFilter(context) },
        include: { entity: true },
      });

      if (!found) {
        return sendFileNotVisible(reply, id, context);
      }

      const { entity, ...file } = found;
      if (await denyContent(reply, entity, context)) {
        return reply;
      }

      const { disposition, filename, noRedirect } = request.query;
      const disposed = contentDisposition(filename || file.filename, { type: disposition });
      const delivery = await content(file, entity, { ...context, contentDisposition: disposed });

      if (!delivery) {
        return reply.code(404).send(createNotFoundError('The requested file could not be retrieved', id));
      }

      return sendDelivery(request, reply, delivery, { contentDisposition: disposed, noRedirect });
    },
  });
};

export default file;
