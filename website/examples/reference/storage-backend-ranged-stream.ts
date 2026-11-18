import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { ContentSource } from 'arocapi';

const origin = 'https://archive.example.com/';

// Proxy Content from an HTTP origin that serves ranges, reading only the bytes the client asked for
export const content: ContentSource = async (file) => {
  const url = new URL((file.meta as { originPath: string }).originPath, origin);
  // Identity, so lengths and ranges count the stored bytes rather than a compressed encoding
  const head = await fetch(url, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } });
  if (head.status === 404) {
    return null;
  }
  if (!head.ok) {
    throw new Error(`Origin answered HEAD with ${head.status}`);
  }

  const length = head.headers.get('content-length');
  if (length === null) {
    throw new Error('Origin answered HEAD without a Content-Length');
  }
  const contentLength = Number(length);
  const etag = head.headers.get('etag') ?? undefined;
  // If-Match compares strongly, so a weak ETag would fail every read
  const ifMatch: Record<string, string> = etag && !etag.startsWith('W/') ? { 'If-Match': etag } : {};
  const lastModified = head.headers.get('last-modified');

  return {
    type: 'stream',
    contentType: file.mediaType,
    contentLength,
    etag,
    lastModified: lastModified ? new Date(lastModified) : undefined,
    open: async ({ start, end }) => {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity', ...ifMatch },
      });
      const whole = start === 0 && end === contentLength - 1;
      if (!response.body || (response.status !== 206 && !(whole && response.status === 200))) {
        throw new Error(`Origin answered bytes ${start}-${end} with ${response.status}`);
      }

      return Readable.fromWeb(response.body as ReadableStream);
    },
  };
};
