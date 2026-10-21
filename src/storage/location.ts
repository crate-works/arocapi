import { isAbsolute, relative, sep } from 'node:path';
import type { Entity, File, Prisma } from '../generated/prisma/client.js';
import type { StorageLocate } from './backend.js';

export const isJsonObject = (value: Prisma.JsonValue | undefined): value is Prisma.JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at `key` in `meta`, or `undefined` when `meta` isn't an object */
export const metaValue = (meta: Prisma.JsonValue, key: string) => (isJsonObject(meta) ? meta[key] : undefined);

/**
 * Read a key of the `meta` shape `Meta`: `null` when absent, a throw naming the entity and key when not a string,
 * `null` included
 */
export const metaString = <Meta>(meta: Prisma.JsonValue, id: string, key: Extract<keyof Meta, string>) => {
  const value = metaValue(meta, key);
  if (value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${id} has a meta.${key} that is not a string`);
  }

  return value;
};

/**
 * Refuse a Storage key that could escape its root: absolute, or with a `..` segment
 */
export const safeKey = (key: string, id: string) => {
  if (isAbsolute(key) || key.split(/[\\/]/).includes('..')) {
    throw new Error(`${id} has an unsafe storage key ${JSON.stringify(key)}`);
  }

  return key;
};

/** Whether `path` is strictly below `root` */
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);

  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

type DefaultKeys<Key> = {
  metadata: (entity: Entity) => Key | null;
  content: (file: File) => Key | null;
};

/**
 * Find each item's key from `locate`, or else from `meta`, throwing through `check` on an unsafe one
 */
export const locator = <Key>(
  locate: StorageLocate<Key>,
  defaults: DefaultKeys<Key>,
  check: (key: Key, id: string) => unknown,
) => {
  const checked = (key: Key | null, id: string) => {
    if (key !== null) {
      check(key, id);
    }

    return key;
  };

  return {
    metadata: async (entity: Entity) => checked(await (locate.metadata ?? defaults.metadata)(entity), entity.id),
    content: async (file: File, entity: Entity) =>
      checked(await (locate.content ?? defaults.content)(file, entity), file.id),
  };
};

/**
 * A `locator` for string keys read from the same `meta` key of `Meta` on entities and files
 */
export const keyLocator = <Meta>(locate: StorageLocate, key: Extract<keyof Meta, string>) =>
  locator(
    locate,
    {
      metadata: (entity) => metaString<Meta>(entity.meta, entity.id, key),
      content: (file) => metaString<Meta>(file.meta, file.id, key),
    },
    safeKey,
  );
