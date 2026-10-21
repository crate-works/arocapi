import { S3Client } from '@aws-sdk/client-s3';
import { S3Storage } from 'arocapi/storage/s3';

const client = new S3Client({ region: 'ap-southeast-2' });

// Redirect to presigned URLs that only need to outlive the start of a download
export const storage = S3Storage({ client, bucket: 'archive', expiresIn: 60 });

// A bucket clients can't reach: arocapi proxies every byte
export const proxied = S3Storage({ client, bucket: 'archive', delivery: 'stream' });
