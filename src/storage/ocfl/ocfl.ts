import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { OcflError, type OcflObject, openStorageRoot, type StorageRoot } from '@ocfl/ocfl-fs';
import type { Entity, File } from '../../generated/prisma/client.js';
import type { OcflLocation, OcflStorageMeta, StorageBackend, StorageLocate, StreamDelivery } from '../backend.js';
import { locator, metaString, safeKey } from '../location.js';
import { withContentType } from '../results.js';

export type OcflStorageOptions = {
  /** The OCFL storage root, whose ocfl_layout.json names a storage layout @ocfl/ocfl-fs implements */
  root: string;
  /** Where each item sits, instead of `meta.ocflObject` and `meta.ocflPath` */
  locate?: StorageLocate<OcflLocation>;
};

const METADATA_PATH = 'ro-crate-metadata.json';

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

const openObject = async (root: StorageRoot, id: string) => {
  try {
    return await root.open(id);
  } catch (error) {
    if (error instanceof OcflError && error.code === 'OBJECT_NOT_FOUND') {
      return null;
    }

    throw error;
  }
};

/** When `path` took the content it has in the head version: the earliest version of the run ending at head */
const changedAt = (object: OcflObject, path: string, digest: string) => {
  let created = object.head.created;
  for (let number = object.head.number - 1; number > 0; number--) {
    const version = object.versions.get(number);
    if (version?.files.get(path)?.digest !== digest) {
      break;
    }
    created = version.created;
  }

  return created;
};

/**
 * Serve Metadata and Content from the head version of objects in an OCFL storage root on local disk
 * Throws an `OcflError` when `root` isn't a storage root, or uses a storage layout @ocfl/ocfl-fs doesn't implement
 */
export const OcflStorage = async ({ root: path, locate = {} }: OcflStorageOptions): Promise<StorageBackend> => {
  const root = await openStorageRoot(path);
  const locations = locator(locate, defaultLocations, safeLocation);

  const deliver = async (location: OcflLocation | null): Promise<StreamDelivery | null> => {
    if (location === null) {
      return null;
    }

    const object = await openObject(root, location.object);
    const file = object?.head.files.get(location.path);
    if (!object || !file) {
      return null;
    }

    return {
      type: 'stream',
      // Typed against the global ReadableStream, which is DOM's under lib dom
      open: () => Readable.fromWeb(file.stream() as ReadableStream<Uint8Array>),
      // Stats the stored file, so missing content fails here rather than after the headers are sent
      contentLength: await file.size(),
      etag: `"${file.digest}"`,
      lastModified: changedAt(object, location.path, file.digest),
    };
  };

  return {
    metadata: async (entity) => deliver(await locations.metadata(entity)),
    content: async (file, entity) =>
      withContentType(await deliver(await locations.content(file, entity)), file.mediaType),
  };
};
