import { type OcflErrorCode, openStorageRoot } from '@ocfl/ocfl-fs';
import type { Entity, File } from '../../generated/prisma/client.js';
import type { OcflLocation, OcflStorageMeta, StorageBackend, StorageLocate, StreamDelivery } from '../backend.js';
import { locator, metaString, safeKey } from '../location.js';
import { nullIfMissing, withContentType } from '../results.js';

export type OcflStorageOptions = {
  /** The OCFL storage root, whose ocfl_layout.json names a storage layout @ocfl/ocfl-fs implements */
  root: string;
  /** Where each item sits, instead of `meta.ocflObject` and `meta.ocflPath` */
  locate?: StorageLocate<OcflLocation>;
};

const METADATA_PATH = 'ro-crate-metadata.json';

const MISSING: ReadonlySet<string> = new Set<OcflErrorCode>(['OBJECT_NOT_FOUND']);

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
 * Throws an `OcflError` when `root` isn't a storage root, or doesn't declare a storage layout @ocfl/ocfl-fs implements
 * @see https://language-research-technology.github.io/ocfl-js/guides/errors/
 */
export const OcflStorage = async ({ root, locate = {} }: OcflStorageOptions): Promise<StorageBackend> => {
  const storageRoot = await openStorageRoot(root);
  const locations = locator(locate, defaultLocations, safeLocation);

  const deliver = async (location: OcflLocation | null): Promise<StreamDelivery | null> => {
    if (location === null) {
      return null;
    }

    const object = await nullIfMissing(storageRoot.open(location.object), MISSING);
    const file = object?.head.files.get(location.path);
    if (!file) {
      return null;
    }

    return {
      type: 'stream',
      open: (range) => file.stream(range),
      contentLength: await file.size(),
      etag: `"${file.digest}"`,
      lastModified: file.modifiedAt,
    };
  };

  return {
    metadata: async (entity) => deliver(await locations.metadata(entity)),
    content: async (file, entity) =>
      withContentType(await deliver(await locations.content(file, entity)), file.mediaType),
  };
};
