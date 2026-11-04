import type { EntityTransformer, Options } from 'arocapi';

const addShortId: EntityTransformer = (entity) => ({ ...entity, shortId: entity.id.split('/').pop() });

// Copy only the values you need from the row; never send `meta` as-is
const addAccessControl: EntityTransformer = (entity, _context, row) => {
  const meta = row.meta as { accessControl?: string } | null;

  return { ...entity, accessControl: meta?.accessControl ?? 'Public', dateModified: row.updatedAt.toISOString() };
};

export const entityTransformers: Options['entityTransformers'] = [addShortId, addAccessControl];
