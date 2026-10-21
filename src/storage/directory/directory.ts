import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DirectoryStorageMeta, PathDelivery, StorageBackend, StorageLocate } from '../backend.js';
import { keyLocator } from '../location.js';
import { nullIfMissing, pathDelivery, withContentType } from '../results.js';

export type DirectoryStorageOptions = {
  /** The directory every Storage key is relative to */
  root: string;
  /** Where each item sits below `root`, instead of `meta.storagePath` */
  locate?: StorageLocate;
};

/**
 * Serve Metadata and Content as files below `root`, found from `Entity.meta.storagePath` and `File.meta.storagePath`
 */
export const DirectoryStorage = ({ root, locate = {} }: DirectoryStorageOptions): StorageBackend => {
  const base = resolve(root);
  const keys = keyLocator<DirectoryStorageMeta>(locate, 'storagePath');

  const deliver = async (key: string | null): Promise<PathDelivery | null> => {
    if (key === null) {
      return null;
    }

    const path = join(base, key);
    const stats = await nullIfMissing(stat(path));
    if (!stats?.isFile()) {
      return null;
    }

    return pathDelivery(path, stats, `W/"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`);
  };

  return {
    metadata: async (entity) => deliver(await keys.metadata(entity)),
    content: async (file, entity) => withContentType(await deliver(await keys.content(file, entity)), file.mediaType),
  };
};
