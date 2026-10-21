import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PathDelivery, StorageBackend, StorageLocate } from '../backend.js';
import { metaString, safeKey } from '../location.js';

export type DirectoryStorageOptions = {
  /** The directory every Storage key is relative to */
  root: string;
  /** Where each item sits below `root`, instead of `meta.storagePath` */
  locate?: StorageLocate;
};

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Serve Metadata and Content as files below `root`, found from `Entity.meta.storagePath` and `File.meta.storagePath`
 */
export const DirectoryStorage = ({ root, locate = {} }: DirectoryStorageOptions): StorageBackend => {
  const base = resolve(root);

  const deliver = async (key: string | null, id: string, contentType: string): Promise<PathDelivery | null> => {
    if (key === null) {
      return null;
    }

    const path = join(base, safeKey(key, id));
    const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (MISSING.has(String(error.code))) {
        return null;
      }

      throw error;
    });
    if (!stats?.isFile()) {
      return null;
    }

    return {
      type: 'path',
      path,
      contentType,
      contentLength: stats.size,
      etag: `W/"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`,
      lastModified: stats.mtime,
    };
  };

  return {
    metadata: async (entity) => {
      const key = locate.metadata ? await locate.metadata(entity) : metaString(entity.meta, entity.id, 'storagePath');

      return deliver(key, entity.id, 'application/ld+json');
    },
    content: async (file, entity) => {
      const key = locate.content ? await locate.content(file, entity) : metaString(file.meta, file.id, 'storagePath');

      return deliver(key, file.id, file.mediaType);
    },
  };
};
