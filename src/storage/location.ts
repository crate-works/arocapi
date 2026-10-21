import { isAbsolute } from 'node:path';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Read a default Storage key from `meta`: `null` when absent, a throw naming the entity and key when not a string
 */
export const metaString = (meta: Prisma.JsonValue, id: string, key: string) => {
  const value = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta[key] : undefined;
  if (value === undefined || value === null) {
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
