import type { Stats } from 'node:fs';
import type { PathDelivery } from './backend.js';

const FS_MISSING: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Resolve to `null` when the error's code or name is in `missing`, else rethrow
 */
export const nullIfMissing = async <T>(promise: Promise<T>, missing = FS_MISSING): Promise<T | null> => {
  try {
    return await promise;
  } catch (error) {
    const { code, name } = error as NodeJS.ErrnoException;
    if (missing.has(String(code)) || missing.has(name)) {
      return null;
    }

    throw error;
  }
};

export const pathDelivery = (path: string, stats: Stats, etag: string): PathDelivery => ({
  type: 'path',
  path,
  contentLength: stats.size,
  etag,
  lastModified: stats.mtime,
});

/** A Content delivery from a backend's shared one, typed by `File.mediaType` */
export const withContentType = <Delivery extends object>(delivery: Delivery | null, contentType: string) =>
  delivery && { ...delivery, contentType };
