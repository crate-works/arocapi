import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Entity, File } from '../../generated/prisma/client.js';
import type { OcflLocation, PathDelivery, StorageBackend, StorageLocate } from '../backend.js';
import { metaString, safeKey } from '../location.js';
import { headFile, layoutObjectRoot } from './ocflFs.js';

export type OcflStorageOptions = {
  /** The OCFL storage root */
  root: string;
  /** Where an object sits, relative to `root`, for a storage layout OcflStorage doesn't implement */
  objectRoot?: (id: string) => string | Promise<string>;
  /** Where each item sits, instead of `meta.ocflObject` and `meta.ocflPath` */
  locate?: StorageLocate<OcflLocation>;
};

const LAYOUTS = new Set([
  '0002-flat-direct-storage-layout',
  '0003-hash-and-id-n-tuple-storage-layout',
  '0004-hashed-n-tuple-storage-layout',
  '000N-path-direct-storage-layout',
]);

const METADATA_PATH = 'ro-crate-metadata.json';

const inside = (base: string, path: string) => {
  const rel = relative(base, path);

  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const readJson = async (path: string): Promise<unknown> => {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  return text === null ? null : JSON.parse(text);
};

const layoutRoot = async (base: string) => {
  const layout = await readJson(join(base, 'ocfl_layout.json'));
  const extension = (layout as { extension?: unknown } | null)?.extension;
  if (typeof extension !== 'string') {
    throw new Error(`${base} has no ocfl_layout.json naming its storage layout; pass objectRoot`);
  }
  if (!LAYOUTS.has(extension)) {
    throw new Error(
      `${base} uses the storage layout ${extension}, which OcflStorage doesn't implement; pass objectRoot`,
    );
  }

  const config = await readJson(join(base, 'extensions', extension, 'config.json'));

  return layoutObjectRoot(base, extension, config as object | null);
};

const metadataLocation = (entity: Entity): OcflLocation | null => {
  const object = metaString(entity.meta, entity.id, 'ocflObject');
  const path = metaString(entity.meta, entity.id, 'ocflPath') ?? METADATA_PATH;

  return object === null ? null : { object, path };
};

const contentLocation = (file: File): OcflLocation | null => {
  const object = metaString(file.meta, file.id, 'ocflObject');
  const path = metaString(file.meta, file.id, 'ocflPath');

  return object === null || path === null ? null : { object, path };
};

/**
 * Serve Metadata and Content from the head version of objects in an OCFL storage root on local disk
 * Throws when `root` isn't a storage root, or uses a storage layout it doesn't implement and no `objectRoot` is given
 */
export const OcflStorage = async ({ root, objectRoot, locate = {} }: OcflStorageOptions): Promise<StorageBackend> => {
  const base = resolve(root);
  if (!(await readdir(base)).some((name) => name.startsWith('0=ocfl_'))) {
    throw new Error(`${base} is not an OCFL storage root`);
  }
  const mapId = objectRoot ?? (await layoutRoot(base));

  const deliver = async (
    location: OcflLocation | null,
    id: string,
    contentType: string,
  ): Promise<PathDelivery | null> => {
    if (location === null) {
      return null;
    }

    const logicalPath = safeKey(location.path, id);
    const objectPath = resolve(base, await mapId(location.object));
    if (!inside(base, objectPath)) {
      throw new Error(`${id}: the root of OCFL object ${location.object} is outside the storage root`);
    }

    const file = await headFile(objectPath, logicalPath);
    if (file === null) {
      return null;
    }

    const path = resolve(objectPath, file.contentPath);
    if (!inside(objectPath, path)) {
      throw new Error(`${id}: OCFL object ${location.object} has a manifest path outside its root`);
    }
    const stats = await stat(path);

    return {
      type: 'path',
      path,
      contentType,
      contentLength: stats.size,
      etag: `"${file.digest}"`,
      lastModified: stats.mtime,
    };
  };

  return {
    metadata: async (entity) => {
      const location = locate.metadata ? await locate.metadata(entity) : metadataLocation(entity);

      return deliver(location, entity.id, 'application/ld+json');
    },
    content: async (file, entity) => {
      const location = locate.content ? await locate.content(file, entity) : contentLocation(file);

      return deliver(location, file.id, file.mediaType);
    },
  };
};
