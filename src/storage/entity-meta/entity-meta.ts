import type { MetadataSource } from '../backend.js';
import { isJsonObject, metaValue } from '../location.js';

export type EntityMetaMetadataOptions = {
  /** The key in `Entity.meta` holding the RO-Crate metadata object */
  key?: string;
};

/**
 * Serve Metadata from the JSON object at `Entity.meta.rocrate`, or another `key`; a Metadata half only
 */
export const EntityMetaMetadata = ({ key = 'rocrate' }: EntityMetaMetadataOptions = {}): MetadataSource => {
  return async (entity) => {
    const value = metaValue(entity.meta, key);
    if (value === undefined) {
      return null;
    }

    if (!isJsonObject(value)) {
      throw new Error(`${entity.id} has a meta.${key} that is not a JSON object`);
    }

    return { type: 'json', value };
  };
};
