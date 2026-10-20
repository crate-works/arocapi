import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { type SearchBackend, SearchQueryError, type SearchRequest, type SearchResult } from '../search/backend.js';
import { boundingBoxSchema, filterValueSchema, geoViolations, splitFilters } from '../search/requestFilters.js';
import { applyTransformers, authoriseEntities } from '../transformers/default.js';
import type { AccessFunction } from '../types/access.js';
import type { EntityTransformer } from '../types/transformers.js';
import type { EntityVisibilityFilter, SearchVisibilityFilter } from '../types/visibility.js';
import { createError, createValidationError, ERROR_CODES } from '../utils/errors.js';

const searchParamsSchema = z.object({
  searchType: z.enum(['basic', 'advanced']).default('basic'),
  query: z.string(),
  filters: z.record(z.string(), filterValueSchema).default({}),
  boundingBox: boundingBoxSchema.optional(),
  geohashPrecision: z.number().int().min(1).max(12).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
  sort: z.string().default('relevance'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

type SearchParams = z.infer<typeof searchParamsSchema>;

type SearchRouteOptions = {
  prisma: PrismaClient;
  search: SearchBackend;
  access: AccessFunction;
  entityTransformers?: EntityTransformer[];
  entityVisibilityFilter: EntityVisibilityFilter;
  searchVisibilityFilter: SearchVisibilityFilter;
};

const search: FastifyPluginAsync<SearchRouteOptions> = async (fastify, opts) => {
  const {
    prisma,
    search: backend,
    access,
    entityTransformers = [],
    entityVisibilityFilter,
    searchVisibilityFilter,
  } = opts;
  const { capabilities } = backend;

  const violations = ({ searchType, filters, sort }: SearchParams) => [
    ...(Object.hasOwn(capabilities.searchTypes, searchType)
      ? []
      : [{ field: '/searchType', message: `${searchType} search isn't supported`, value: searchType }]),
    ...Object.keys(filters)
      .filter((key) => !Object.hasOwn(capabilities.filters, key))
      .map((key) => ({ field: `/filters/${key}`, message: `${key} isn't a declared filter` })),
    ...(sort === 'relevance' || Object.hasOwn(capabilities.sorts, sort)
      ? []
      : [{ field: '/sort', message: `${sort} isn't a declared sort`, value: sort }]),
  ];

  fastify.withTypeProvider<ZodTypeProvider>().post(
    '/search',
    {
      schema: {
        body: searchParamsSchema,
      },
    },
    async (request, reply) => {
      const { filters, violations: filterProblems } = splitFilters(capabilities.filters, request.body.filters);
      const problems = [
        ...violations(request.body),
        ...filterProblems,
        ...geoViolations(capabilities.geo, request.body),
      ];
      if (problems.length > 0) {
        return reply.code(400).send(createValidationError('The request parameters are invalid', problems));
      }

      const { searchType, query, boundingBox, geohashPrecision, limit, offset, sort, order } = request.body;

      if (searchType === 'advanced' && query.trim() !== '') {
        const message = "Advanced queries aren't supported yet";

        return reply.code(422).send(createValidationError(message, [{ field: 'query', message }]));
      }

      const context = { request, fastify };
      const [visibilityWhere, visibility] = await Promise.all([
        entityVisibilityFilter(context),
        searchVisibilityFilter(context),
      ]);

      const searchRequest: SearchRequest = {
        ...(searchType === 'basic' ? { searchType, query } : { searchType, query: { type: 'all' } }),
        filters,
        ...(boundingBox && { boundingBox }),
        ...(geohashPrecision !== undefined && { geohashPrecision }),
        limit,
        offset,
        sort,
        order,
        visibility,
      };

      const start = performance.now();
      let result: SearchResult;
      try {
        result = await backend.search(searchRequest, context);
      } catch (error) {
        if (!(error instanceof SearchQueryError)) {
          throw error;
        }

        fastify.log.warn(`Invalid search query: ${error.message}`);

        return reply.code(422).send(createError(ERROR_CODES.VALIDATION_ERROR, error.message));
      }
      const searchTime = Math.round(performance.now() - start);

      const dbEntities = await prisma.entity.findMany({
        where: {
          AND: [{ id: { in: result.hits.map(({ id }) => id) } }, visibilityWhere],
        },
        include: { file: { select: { id: true } } },
      });

      const authorisedEntities = await authoriseEntities(dbEntities, prisma, access, context);
      const entityMap = new Map(authorisedEntities.map((entity) => [entity.id, entity]));

      const entities = await Promise.all(
        result.hits.map(async ({ id, searchExtra }) => {
          const authorisedEntity = entityMap.get(id);
          if (!authorisedEntity) {
            fastify.log.warn(`Entity ${id} found by the search backend but missing or not visible in database`);

            return null;
          }

          const transformed = await applyTransformers(authorisedEntity, entityTransformers, context);

          return searchExtra === undefined ? transformed : { ...(transformed as object), searchExtra };
        }),
      ).then((results) => results.filter((entity) => entity !== null));

      return {
        total: result.total,
        searchTime,
        entities,
        facets: {
          ...Object.fromEntries(Object.keys(capabilities.facets).map((name) => [name, []])),
          ...result.facets,
        },
        ...(result.geohashGrid && { geohashGrid: result.geohashGrid }),
      };
    },
  );
};

export default search;
