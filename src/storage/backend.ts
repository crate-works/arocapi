import type { Readable } from 'node:stream';
import type { Entity, File } from '../generated/prisma/client.js';
import type { RequestContext } from '../types/context.js';

type MaybePromise<T> = T | Promise<T>;

/**
 * Headers a `stream` or `path` delivery carries, read from storage rather than the database
 */
export type DeliveryHeaders = {
  /** Ignored for Metadata, which is always `application/ld+json` */
  contentType: string;
  contentLength: number;
  etag?: string;
  lastModified?: Date;
};

/** Bytes the library streams; `open` is called only on GET */
export type StreamDelivery = { type: 'stream'; open: () => MaybePromise<Readable> } & DeliveryHeaders;

/** An absolute path on disk the library opens on GET */
export type PathDelivery = { type: 'path'; path: string } & DeliveryHeaders;

/** A URL the client is sent to: 302, or 200 `{ location }` under `?noRedirect=true` */
export type RedirectDelivery = { type: 'redirect'; url: string };

/** A value the library serialises once, with the length and a strong ETag from those bytes */
export type JsonDelivery = { type: 'json'; value: unknown };

export type ContentDelivery = StreamDelivery | PathDelivery | RedirectDelivery;

export type MetadataDelivery = ContentDelivery | JsonDelivery;

export type ContentContext = RequestContext & {
  /** The `Content-Disposition` the library sends on `stream` and `path` deliveries, for baking into a redirect */
  contentDisposition: string;
};

/**
 * Deliver an entity's Metadata, or `null` for a 404; HEAD and GET make the same call
 */
export type MetadataSource = (entity: Entity, context: RequestContext) => MaybePromise<MetadataDelivery | null>;

/**
 * Deliver a file's Content, or `null` for a 404; `entity` is the file's entity, with its `meta`
 */
export type ContentSource = (
  file: File,
  entity: Entity,
  context: ContentContext,
) => MaybePromise<ContentDelivery | null>;

export type StorageBackend = { metadata: MetadataSource; content: ContentSource };

/**
 * Where a stored reference backend finds each item, overriding the default key it reads from `meta`
 */
export type StorageLocate<Key = string> = {
  metadata?: (entity: Entity) => MaybePromise<Key | null>;
  content?: (file: File, entity: Entity) => MaybePromise<Key | null>;
};

/** What `DirectoryStorage` reads from `File.meta` and `Entity.meta`: a path relative to its root */
export type DirectoryStorageMeta = { storagePath: string };

/** What `S3Storage` reads from `File.meta` and `Entity.meta`: a key relative to the bucket */
export type S3StorageMeta = { storageKey: string };

/** What `OcflStorage` reads from `File.meta` and `Entity.meta`; Metadata's `ocflPath` defaults to `ro-crate-metadata.json` */
export type OcflStorageMeta = { ocflObject: string; ocflPath?: string };

/** An OCFL object id and a logical path inside its head version */
export type OcflLocation = { object: string; path: string };
