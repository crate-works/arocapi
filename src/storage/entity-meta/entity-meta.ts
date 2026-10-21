import type { Prisma } from '../../generated/prisma/client.js';
import type { MetadataSource } from '../backend.js';

export type EntityMetaMetadataOptions = {
  /** The key in `Entity.meta` holding the RO-Crate metadata object */
  key?: string;
};

const isObject = (value: Prisma.JsonValue | undefined) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Serve Metadata from the JSON object at `Entity.meta.rocrate`, or another `key`; a Metadata half only
 */
export const EntityMetaMetadata = ({ key = 'rocrate' }: EntityMetaMetadataOptions = {}): MetadataSource => {
  return async (entity) => {
    const value = isObject(entity.meta) ? (entity.meta as Prisma.JsonObject)[key] : undefined;
    if (value === undefined) {
      return null;
    }

    if (!isObject(value)) {
      throw new Error(`${entity.id} has a meta.${key} that is not a JSON object`);
    }

    return { type: 'json', value };
  };
};
