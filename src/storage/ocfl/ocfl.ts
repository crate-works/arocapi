import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Entity, File } from '../../generated/prisma/client.js';
import type {
  MaybePromise,
  OcflLocation,
  OcflStorageMeta,
  PathDelivery,
  StorageBackend,
  StorageLocate,
} from '../backend.js';
import { inside, locator, metaString, safeKey } from '../location.js';
import { nullIfMissing, pathDelivery, withContentType } from '../results.js';
import { headFile, layoutObjectRoot } from './ocflFs.js';

export type OcflStorageOptions = {
  /** The OCFL storage root */
  root: string;
  /** Where an object sits, relative to `root`, for a storage layout OcflStorage doesn't implement */
  objectRoot?: (id: string) => MaybePromise<string>;
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

const MARKERS = ['0=ocfl_1.1', '0=ocfl_1.0'];

const readJson = async (path: string): Promise<unknown> => {
  const text = await nullIfMissing(readFile(path, 'utf8'));

  return text === null ? null : JSON.parse(text);
};

const readLayoutObjectRoot = async (base: string) => {
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

const metaKey = (row: Entity | File, key: keyof OcflStorageMeta) => metaString<OcflStorageMeta>(row.meta, row.id, key);

const defaultLocations = {
  metadata: (entity: Entity): OcflLocation | null => {
    const object = metaKey(entity, 'ocflObject');
    const path = metaKey(entity, 'ocflPath') ?? METADATA_PATH;

    return object === null ? null : { object, path };
  },
  content: (file: File): OcflLocation | null => {
    const object = metaKey(file, 'ocflObject');
    const path = metaKey(file, 'ocflPath');

    return object === null || path === null ? null : { object, path };
  },
};

/** An object id is mapped by the layout, so only the logical path is a key */
const safeLocation = ({ path }: OcflLocation, id: string) => safeKey(path, id);

/**
 * Serve Metadata and Content from the head version of objects in an OCFL storage root on local disk
 * Throws when `root` isn't a storage root, or uses a storage layout it doesn't implement and no `objectRoot` is given
 */
export const OcflStorage = async ({
  root,
  objectRoot: custom,
  locate = {},
}: OcflStorageOptions): Promise<StorageBackend> => {
  const base = resolve(root);
  const markers = await Promise.all(MARKERS.map((name) => nullIfMissing(stat(join(base, name)))));
  if (!markers.some(Boolean)) {
    throw new Error(`${base} is not an OCFL storage root`);
  }
  const objectRoot = custom ?? (await readLayoutObjectRoot(base));
  const locations = locator(locate, defaultLocations, safeLocation);

  const deliver = async (location: OcflLocation | null, id: string): Promise<PathDelivery | null> => {
    if (location === null) {
      return null;
    }

    const objectPath = resolve(base, await objectRoot(location.object));
    if (!inside(base, objectPath)) {
      throw new Error(`${id}: the root of OCFL object ${location.object} is outside the storage root`);
    }

    const file = await headFile(objectPath, location.path);
    if (file === null) {
      return null;
    }

    const path = resolve(objectPath, file.contentPath);
    if (!inside(objectPath, path)) {
      throw new Error(`${id}: OCFL object ${location.object} has a manifest path outside its root`);
    }

    const stats = await stat(path);
    if (!stats.isFile()) {
      throw new Error(`${id}: OCFL object ${location.object} has a manifest path that is not a file`);
    }

    return pathDelivery(path, stats, `"${file.digest}"`);
  };

  return {
    metadata: async (entity) => deliver(await locations.metadata(entity), entity.id),
    content: async (file, entity) =>
      withContentType(await deliver(await locations.content(file, entity), file.id), file.mediaType),
  };
};
