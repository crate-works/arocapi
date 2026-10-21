import sensible from '@fastify/sensible';
import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from './generated/prisma/client.js';
import capabilities from './routes/capabilities.js';
import entities from './routes/entities.js';
import entity from './routes/entity.js';
import file from './routes/file.js';
import files from './routes/files.js';
import metadata from './routes/metadata.js';
import search from './routes/search.js';
import type { SearchBackend } from './search/backend.js';
import type { SearchVisibilityWhere } from './search/visibility.js';
import type { StorageBackend } from './storage/backend.js';
import type { AccessFunction } from './types/access.js';
import type { IsAuthenticated, RequestContext } from './types/context.js';
import type { EntityTransformer, FileTransformer } from './types/transformers.js';
import type { EntityVisibilityFilter } from './types/visibility.js';
import { notFoundHandler } from './utils/errors.js';
import { setupValidation } from './utils/validation.js';

export type {
  AdvancedQuery,
  BackendSearchCapability,
  BoundingBox,
  FacetBucket,
  RangeBound,
  RangeFilter,
  SearchBackend,
  SearchExtra,
  SearchRequest,
  SearchResult,
} from './search/backend.js';
export { SearchQueryError } from './search/backend.js';
export type {
  FieldDeclaration,
  FieldDeclarations,
  FieldType,
  GeoPoint,
  SearchDocument,
} from './search/fields.js';
export { capabilitiesFromFields } from './search/fields.js';
export type { SearchVisibilityWhere, VisibilityCondition } from './search/visibility.js';
export { checkSearchVisibility } from './search/visibility.js';
export type {
  ContentContext,
  ContentDelivery,
  ContentSource,
  DeliveryHeaders,
  DirectoryStorageMeta,
  JsonDelivery,
  MetadataDelivery,
  MetadataSource,
  OcflLocation,
  OcflStorageMeta,
  PathDelivery,
  RedirectDelivery,
  S3StorageMeta,
  StorageBackend,
  StorageLocate,
  StreamDelivery,
} from './storage/backend.js';
export type {
  AuthorisedEntity,
  AuthorisedFile,
  BaseEntity,
  StandardEntity,
  StandardFile,
} from './transformers/default.js';
export type { AccessFunction, AccessInfo } from './types/access.js';
export type { IsAuthenticated, RequestContext } from './types/context.js';
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

const DOCS_URL = 'https://arocapi.crate-works.org';

const REMOVED_OPTIONS: Record<string, { replacement: string; docs: string }> = {
  accessTransformer: { replacement: 'access', docs: `${DOCS_URL}/configuration/access/` },
  fileAccessTransformer: { replacement: 'access', docs: `${DOCS_URL}/configuration/access/` },
  hiddenResponse: {
    replacement: 'promptLoginForHidden and isAuthenticated',
    docs: `${DOCS_URL}/configuration/visibility/#promptloginforhidden`,
  },
};

type PrismaMethod = (args: never) => PromiseLike<unknown>;
type PrismaDelegate = Record<'findMany' | 'findFirst' | 'count', PrismaMethod>;

/**
 * The Prisma client arocapi needs: any Prisma 7 client generated from a schema that includes the arocapi models,
 * including one with extra models, a `$extends` client or the client inside `$transaction`
 */
export type ArocapiPrismaClient = { entity: PrismaDelegate; file: PrismaDelegate };

export type Options = {
  prisma: ArocapiPrismaClient;
  search: SearchBackend;
  access: AccessFunction;
  entityTransformers?: EntityTransformer[];
  fileTransformers?: FileTransformer[];
  /** Where Metadata and Content come from */
  storage: StorageBackend;
  entityVisibilityFilter: EntityVisibilityFilter;
  /** A `SearchVisibilityFilter<typeof fields>` for the search backend's declared fields */
  searchVisibilityFilter: (context: RequestContext) => Promise<SearchVisibilityWhere> | SearchVisibilityWhere;
  isAuthenticated?: IsAuthenticated;
  promptLoginForHidden?: boolean;
};
const app: FastifyPluginAsync<Options> = async (fastify, options) => {
  const {
    search: searchBackend,
    access,
    entityTransformers,
    fileTransformers,
    storage,
    entityVisibilityFilter,
    searchVisibilityFilter,
    isAuthenticated,
    promptLoginForHidden = false,
  } = options;

  if (!options.prisma) {
    throw new Error('Prisma client is required');
  }

  if (typeof options.prisma.entity?.findMany !== 'function' || typeof options.prisma.file?.findMany !== 'function') {
    throw new Error('prisma must be a Prisma 7 client generated from a schema that includes the arocapi models');
  }

  // Consumers generate their own client, whose delegate generics never match ours; the routes need the full type
  const prisma = options.prisma as PrismaClient;

  if (!searchBackend) {
    throw new Error('search is required');
  }

  for (const [removed, { replacement, docs }] of Object.entries(REMOVED_OPTIONS)) {
    if ((options as Record<string, unknown>)[removed] !== undefined) {
      throw new Error(`${removed} has been replaced by ${replacement}, see ${docs}`);
    }
  }

  if (!access) {
    throw new Error('access is required');
  }

  if (!storage) {
    throw new Error('storage is required');
  }

  if (!storage.metadata) {
    throw new Error('storage.metadata is required');
  }

  if (!storage.content) {
    throw new Error('storage.content is required');
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

  fastify.register(capabilities, { search: searchBackend });
  fastify.register(entities, { prisma, access, entityTransformers, entityVisibilityFilter });
  fastify.register(entity, { prisma, access, entityTransformers, entityVisibilityFilter, refusal });
  fastify.register(files, { prisma, access, fileTransformers, entityVisibilityFilter });
  fastify.register(file, { prisma, content: storage.content, access, entityVisibilityFilter, refusal });
  fastify.register(metadata, { prisma, metadata: storage.metadata, access, entityVisibilityFilter, refusal });
  fastify.register(search, {
    prisma,
    search: searchBackend,
    access,
    entityTransformers,
    entityVisibilityFilter,
    searchVisibilityFilter,
  });
};

export default app;
