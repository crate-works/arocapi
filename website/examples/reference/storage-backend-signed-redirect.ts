import type { ContentSource } from 'arocapi';

// Your token signer, e.g. a JWT library's sign()
declare function sign(payload: { fileId: string; disposition: string }, options: { expiresIn: number }): string;

// Redirect to your own content route, which verifies the token and serves the file with Range support
export const content: ContentSource = (file, _entity, { contentDisposition }) => ({
  type: 'redirect',
  url: `/content/${sign({ fileId: file.id, disposition: contentDisposition }, { expiresIn: 60 })}`,
});
