import { S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from 'arocapi/storage/s3';

const client = new S3Client({ region: 'ap-southeast-2' });

// Metadata from Entity.meta.storageKey and Content from File.meta.storageKey; Content redirects to a presigned URL
export const storage = S3Storage({ client, bucket: 'archive' });

// Or proxy Content through arocapi, keeping the bucket private
export const proxied = S3Storage({ client, bucket: 'archive', delivery: 'stream' });
