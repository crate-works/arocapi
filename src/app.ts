import sensible from '@fastify/sensible';
import type { Client } from '@opensearch-project/opensearch';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from './generated/prisma/client.js';
import capabilities from './routes/capabilities.js';
import entities from './routes/entities.js';
import entity from './routes/entity.js';
import file from './routes/file.js';
import files from './routes/files.js';
import metadata from './routes/metadata.js';
import search from './routes/search.js';
import type { AccessFunction } from './types/access.js';
import type { IsAuthenticated } from './types/context.js';
import type { FileHandler, RoCrateHandler } from './types/fileHandlers.js';
import type { EntityTransformer, FileTransformer } from './types/transformers.js';
import type { EntityVisibilityFilter, SearchVisibilityFilter } from './types/visibility.js';
import { notFoundHandler } from './utils/errors.js';
import type { FacetCapability, FilterCapability, QueryBuilderOptions, SearchCapability } from './utils/queryBuilder.js';
import { OpensearchQueryBuilder } from './utils/queryBuilder.js';
import { setupValidation } from './utils/validation.js';

export type {
  AuthorisedEntity,
  AuthorisedFile,
  BaseEntity,
  StandardEntity,
  StandardFile,
} from './transformers/default.js';
export type { AccessFunction, AccessInfo } from './types/access.js';
export type { IsAuthenticated, RequestContext } from './types/context.js';
export type {
  FileHandler,
  FileMetadata,
  FilePathResult,
  FileRedirectResult,
  FileResult,
  FileStreamResult,
  GetFileHandler,
  GetRoCrateHandler,
  HeadFileHandler,
  HeadRoCrateHandler,
  RoCrateHandler,
} from './types/fileHandlers.js';
export type { EntityTransformer, FileTransformer } from './types/transformers.js';
export type { EntityVisibilityFilter, SearchVisibilityFilter } from './types/visibility.js';
export type { LicenceAccessOptions } from './utils/access.js';
export { AllPublicAccess, LicenceAccess } from './utils/access.js';
export type { ErrorCode, StandardErrorResponse } from './utils/errors.js';
export {
  createAuthenticationRequiredError,
  createError,
  createForbiddenError,
  createInternalError,
  createNotFoundError,
  createValidationError,
  ERROR_CODES,
  errorHandler,
  notFoundHandler,
} from './utils/errors.js';
export { AllVisibleEntityFilter, AllVisibleSearchFilter } from './utils/visibility.js';
export type { FacetCapability, FilterCapability, QueryBuilderOptions, SearchCapability };
export { OpensearchQueryBuilder };

const DOCS_URL = 'https://arocapi.crate-works.org';

const REMOVED_OPTIONS: Record<string, { replacement: string; docs: string }> = {
  accessTransformer: { replacement: 'access', docs: `${DOCS_URL}/configuration/access/` },
  fileAccessTransformer: { replacement: 'access', docs: `${DOCS_URL}/configuration/access/` },
  hiddenResponse: {
    replacement: 'promptLoginForHidden and isAuthenticated',
    docs: `${DOCS_URL}/configuration/visibility/#promptloginforhidden`,
  },
};

export type Options = {
  prisma: PrismaClient;
  opensearch: Client;
  queryBuilderClass?: typeof OpensearchQueryBuilder;
  queryBuilderOptions?: QueryBuilderOptions;
  access: AccessFunction;
  entityTransformers?: EntityTransformer[];
  fileTransformers?: FileTransformer[];
  fileHandler: FileHandler;
  roCrateHandler: RoCrateHandler;
  entityVisibilityFilter: EntityVisibilityFilter;
  searchVisibilityFilter: SearchVisibilityFilter;
  isAuthenticated?: IsAuthenticated;
  promptLoginForHidden?: boolean;
};
const app: FastifyPluginAsync<Options> = async (fastify, options) => {
  const {
    prisma,
    opensearch,
    queryBuilderClass,
    queryBuilderOptions,
    access,
    entityTransformers,
    fileTransformers,
    fileHandler,
    roCrateHandler,
    entityVisibilityFilter,
    searchVisibilityFilter,
    isAuthenticated,
    promptLoginForHidden = false,
  } = options;

  if (!prisma) {
    throw new Error('Prisma client is required');
  }

  if (typeof prisma.entity?.findMany !== 'function' || typeof prisma.file?.findMany !== 'function') {
    throw new Error('prisma must be a Prisma 7 client generated from a schema that includes the arocapi models');
  }

  if (!opensearch) {
    throw new Error('OpenSearch client is required');
  }

  for (const [removed, { replacement, docs }] of Object.entries(REMOVED_OPTIONS)) {
    if ((options as Record<string, unknown>)[removed] !== undefined) {
      throw new Error(`${removed} has been replaced by ${replacement}, see ${docs}`);
    }
  }

  if (!access) {
    throw new Error('access is required');
  }

  if (!fileHandler) {
    throw new Error('fileHandler is required');
  }

  if (!roCrateHandler) {
    throw new Error('roCrateHandler is required');
  }

  if (!entityVisibilityFilter) {
    throw new Error('entityVisibilityFilter is required');
  }

  if (!searchVisibilityFilter) {
    throw new Error('searchVisibilityFilter is required');
  }

  if (promptLoginForHidden && !isAuthenticated) {
    throw new Error('promptLoginForHidden requires isAuthenticated');
  }

  const refusal = { isAuthenticated, promptLoginForHidden };

  fastify.register(sensible);
  setupValidation(fastify);

  // Fastify only gives a plugin its own not-found handler when registered with its own prefix
  const { prefix } = options as { prefix?: string };
  if (prefix && prefix !== '/') {
    fastify.setNotFoundHandler(notFoundHandler);
  }

  const queryBuilder = new (queryBuilderClass ?? OpensearchQueryBuilder)(queryBuilderOptions);

  fastify.register(capabilities, { queryBuilder });
  fastify.register(entities, { prisma, access, entityTransformers, entityVisibilityFilter });
  fastify.register(entity, { prisma, access, entityTransformers, entityVisibilityFilter, refusal });
  fastify.register(files, { prisma, access, fileTransformers, entityVisibilityFilter });
  fastify.register(file, { prisma, fileHandler, access, entityVisibilityFilter, refusal });
  fastify.register(metadata, { prisma, roCrateHandler, access, entityVisibilityFilter, refusal });
  fastify.register(search, {
    prisma,
    opensearch,
    access,
    entityTransformers,
    queryBuilder,
    entityVisibilityFilter,
    searchVisibilityFilter,
  });
};

export default app;
