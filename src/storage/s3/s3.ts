import type { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageBackend, StorageLocate, StreamDelivery } from '../backend.js';
import { metaString, safeKey } from '../location.js';

export type S3StorageOptions = {
  /** Your S3 client; arocapi never configures or destroys it */
  client: S3Client;
  bucket: string;
  /** Where each item sits in the bucket, instead of `meta.storageKey` */
  locate?: StorageLocate;
  /** How Content reaches the client: a presigned URL (default), or proxied through arocapi. Metadata always streams */
  delivery?: 'redirect' | 'stream';
  /** Seconds a presigned URL stays valid */
  expiresIn?: number;
};

const MISSING = new Set(['NoSuchKey', 'NotFound']);

/**
 * Serve Metadata and Content from an S3-compatible bucket, found from `Entity.meta.storageKey` and `File.meta.storageKey`
 */
export const S3Storage = ({
  client,
  bucket,
  locate = {},
  delivery = 'redirect',
  expiresIn = 300,
}: S3StorageOptions): StorageBackend => {
  const stream = async (key: string, contentType: string): Promise<StreamDelivery | null> => {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).catch((error: Error) => {
      if (MISSING.has(error.name)) {
        return null;
      }

      throw error;
    });
    if (!head) {
      return null;
    }

    return {
      type: 'stream',
      contentType,
      contentLength: Number(head.ContentLength),
      etag: head.ETag,
      lastModified: head.LastModified,
      // IfMatch keeps GET to the version HEAD described; a newer one fails the request
      open: async () => {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: head.ETag }));

        return object.Body as Readable;
      },
    };
  };

  return {
    metadata: async (entity) => {
      const key = locate.metadata ? await locate.metadata(entity) : metaString(entity.meta, entity.id, 'storageKey');

      return key === null ? null : stream(safeKey(key, entity.id), 'application/ld+json');
    },
    content: async (file, entity, { contentDisposition }) => {
      const key = locate.content ? await locate.content(file, entity) : metaString(file.meta, file.id, 'storageKey');
      if (key === null) {
        return null;
      }

      const Key = safeKey(key, file.id);
      if (delivery === 'stream') {
        return stream(Key, file.mediaType);
      }

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key,
        ResponseContentType: file.mediaType,
        ResponseContentDisposition: contentDisposition,
      });

      return { type: 'redirect', url: await getSignedUrl(client, command, { expiresIn }) };
    },
  };
};
