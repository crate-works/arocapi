import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * A client for the `test-s3` VersityGW container in docker-compose.test.yml and the CI services
 */
export const testS3Client = (secretAccessKey = 'test-secret-key') =>
  new S3Client({
    endpoint: 'http://localhost:7070',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test-access-key', secretAccessKey },
  });

/**
 * Create `bucket` unless it exists, then write each item at its path
 */
export const putTestObjects = async (
  client: S3Client,
  bucket: string,
  items: readonly { path: string; body: string }[],
) => {
  await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((error: Error) => {
    if (error.name !== 'BucketAlreadyOwnedByYou') {
      throw error;
    }
  });
  await Promise.all(
    items.map(({ path, body }) => client.send(new PutObjectCommand({ Bucket: bucket, Key: path, Body: body }))),
  );
};
