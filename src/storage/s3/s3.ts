import type { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3StorageMeta, StorageBackend, StorageLocate, StreamDelivery } from '../backend.js';
import { keyLocator } from '../location.js';
import { nullIfMissing, withContentType } from '../results.js';

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

const MISSING: ReadonlySet<string> = new Set(['NoSuchKey', 'NotFound']);

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
  const keys = keyLocator<S3StorageMeta>(locate, 'storageKey');

  const stream = async (key: string | null): Promise<StreamDelivery | null> => {
    if (key === null) {
      return null;
    }

    const head = await nullIfMissing(client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })), MISSING);
    if (!head) {
      return null;
    }

    return {
      type: 'stream',
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
    metadata: async (entity) => stream(await keys.metadata(entity)),
    content: async (file, entity, { contentDisposition }) => {
      const Key = await keys.content(file, entity);
      if (delivery === 'stream') {
        return withContentType(await stream(Key), file.mediaType);
      }
      if (Key === null) {
        return null;
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
