import type { ContentSource } from 'arocapi';

// Your object store's presigner, e.g. from its SDK
declare function presign(key: string, options: { expiresIn: number; contentDisposition: string }): Promise<string>;

type FileMeta = { objectKey: string };

export const content: ContentSource = async (file, _entity, { contentDisposition }) => {
  const url = await presign((file.meta as FileMeta).objectKey, { expiresIn: 60, contentDisposition });

  return { type: 'redirect', url };
};
