import type { Entity, File, PrismaClient } from '../generated/prisma/client.js';
import type { AccessFunction, AccessInfo } from '../types/access.js';
import type { RequestContext } from '../types/context.js';

/**
 * An entity's stored database row: its Record fields, `meta`, `createdAt` and `updatedAt`
 * Never sent as-is; `meta` can be large
 */
export type EntityRow = Entity;

/**
 * A file's stored database row with its file entity's row
 * Never sent as-is; `meta` can be large
 */
export type FileRow = File & { entity: EntityRow };

/**
 * Entity reference - used for memberOf and rootCollection
 */
type EntityReference = {
  id: string;
  name: string;
};

/**
 * Base entity shape - an entity's Record fields with memberOf and rootCollection as ids
 * The access function receives this shape, so deciding access never looks up parent entities
 */
export type BaseEntity = {
  id: string;
  entityType: string;
  name: string;
  description: string;
  memberOf: string | null;
  rootCollection: string | null;
  metadataLicenseId: string;
  contentLicenseId: string;
};

/**
 * Standard entity shape - with resolved references
 * Does not include access information
 */
export type StandardEntity = {
  id: string;
  entityType: string;
  name: string;
  description: string;
  memberOf: EntityReference | null;
  rootCollection: EntityReference | null;
  metadataLicenseId: string;
  contentLicenseId: string;
};

/**
 * Authorised entity - a standard entity with the access function's result attached
 */
export type AuthorisedEntity = StandardEntity & {
  access: AccessInfo;
};

type FileAccessInfo = Pick<AccessInfo, 'content' | 'contentAuthorizationUrl'>;

/**
 * Standard file shape - output of base file transformation
 * Does not include access information
 */
export type StandardFile = {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
};

/**
 * Authorised file - a standard file with its file entity's Content access attached
 */
export type AuthorisedFile = StandardFile & {
  access: FileAccessInfo;
};

/**
 * Base entity transformer - always applied first
 * Transforms raw database entity to base entity shape with unresolved references
 */
export const baseEntityTransformer = (entity: EntityRow): BaseEntity => {
  const base: BaseEntity = {
    id: entity.id,
    name: entity.name,
    description: entity.description,
    entityType: entity.entityType,
    memberOf: entity.memberOf,
    rootCollection: entity.rootCollection,
    metadataLicenseId: entity.metadataLicenseId,
    contentLicenseId: entity.contentLicenseId,
  };

  return base;
};

/**
 * Base file transformer - always applied first
 * Transforms raw database file to standard file shape (without access)
 */
const baseFileTransformer = (file: File): StandardFile => ({
  id: file.id,
  filename: file.filename,
  mediaType: file.mediaType,
  size: Number(file.size),
});

/**
 * Resolve entity references (memberOf/rootCollection) to objects with id and name
 * Batch-fetches all referenced entities in a single query for performance
 *
 * @param entities - Array of entities with memberOf/rootCollection string IDs
 * @param prisma - Prisma client instance
 * @returns Map of entity ID to EntityReference object
 */
const resolveEntityReferences = async (
  entities: Array<{ memberOf: string | null; rootCollection: string | null }>,
  prisma: PrismaClient,
): Promise<Map<string, EntityReference>> => {
  const refIds = new Set<string>();

  entities.forEach((e) => {
    if (e.memberOf) {
      refIds.add(e.memberOf);
    }

    if (e.rootCollection) {
      refIds.add(e.rootCollection);
    }
  });

  if (refIds.size === 0) {
    return new Map();
  }

  const refs = await prisma.entity.findMany({
    where: { id: { in: [...refIds] } },
    select: { id: true, name: true },
  });

  return new Map(refs.map((r) => [r.id, { id: r.id, name: r.name }]));
};

/**
 * Transform database entities to standard entities, resolving their references in one query
 */
const toStandardEntities = async (entities: EntityRow[], prisma: PrismaClient): Promise<StandardEntity[]> => {
  const refMap = await resolveEntityReferences(entities, prisma);

  return entities.map((entity) => {
    const base = baseEntityTransformer(entity);

    return {
      ...base,
      memberOf: base.memberOf ? (refMap.get(base.memberOf) ?? null) : null,
      rootCollection: base.rootCollection ? (refMap.get(base.rootCollection) ?? null) : null,
    };
  });
};

const pickAccess = ({
  metadata,
  content,
  metadataAuthorizationUrl,
  contentAuthorizationUrl,
}: AccessInfo): AccessInfo => ({
  metadata,
  content,
  ...(metadataAuthorizationUrl && { metadataAuthorizationUrl }),
  ...(contentAuthorizationUrl && { contentAuthorizationUrl }),
});

/**
 * Decide access to database entities with the access function
 */
export const decideAccess = async (
  entities: EntityRow[],
  access: AccessFunction,
  context: RequestContext,
): Promise<AccessInfo[]> =>
  Promise.all(entities.map(async (entity) => pickAccess(await access(baseEntityTransformer(entity), context, entity))));

/**
 * Transform database entities to standard entities with the access function's result attached, in input order
 */
export const authoriseEntities = async (
  entities: EntityRow[],
  prisma: PrismaClient,
  access: AccessFunction,
  context: RequestContext,
): Promise<AuthorisedEntity[]> => {
  const [standardEntities, entityAccess] = await Promise.all([
    toStandardEntities(entities, prisma),
    decideAccess(entities, access, context),
  ]);

  return standardEntities.map((entity, i) => ({ ...entity, access: entityAccess[i] }));
};

/**
 * Transform database files to standard files with their file entity's Content access attached, in input order
 */
export const authoriseFiles = async (
  files: FileRow[],
  access: AccessFunction,
  context: RequestContext,
): Promise<AuthorisedFile[]> => {
  const fileEntityAccess = await decideAccess(
    files.map((file) => file.entity),
    access,
    context,
  );

  return files.map((file, i) => {
    const { metadata: _metadata, metadataAuthorizationUrl: _metadataUrl, ...fileAccess } = fileEntityAccess[i];

    return { ...baseFileTransformer(file), access: fileAccess };
  });
};

/**
 * Apply consumer transformers in order, each receiving the previous one's output
 */
export const applyTransformers = async <T, R>(
  item: T,
  transformers: Array<(item: T, context: RequestContext, row: R) => Promise<T> | T>,
  context: RequestContext,
  row: R,
): Promise<T> => {
  let result = item;
  for (const transformer of transformers) {
    result = await transformer(result, context, row);
  }

  return result;
};
