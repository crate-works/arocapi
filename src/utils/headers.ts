import type { FastifyReply } from 'fastify';

/** Sandboxes deposited bytes; see docs/adr/0005-library-sandboxes-delivered-bytes.md */
const contentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const token = "[!#$%&'*+\\-.^_`|~0-9a-z]+";
const quotedString = '"(?:[^"\\\\]|\\\\.)*"';
const mediaType = new RegExp(
  `^(?:audio|video)/${token}(?:[ \\t]*;[ \\t]*${token}=(?:${token}|${quotedString}))*[ \\t]*$`,
  'i',
);

// Chrome won't play media opened directly under this CSP, and a media document can't run script.
// RFC 9110 grammar, so no comma outside quotes: browsers split the header as a list, respecting
// quotes, and take the last type, so `audio/mpeg, text/html` is HTML
const isMedia = (contentType: string) => mediaType.test(contentType);

export const setDeliveryHeaders = (
  reply: FastifyReply,
  metadata: { contentType: string; contentLength: number; etag?: string; lastModified?: Date },
) => {
  reply.header('Content-Type', metadata.contentType);
  reply.header('Content-Length', metadata.contentLength.toString());
  if (metadata.etag) {
    reply.header('ETag', metadata.etag);
  }
  if (metadata.lastModified) {
    reply.header('Last-Modified', metadata.lastModified.toUTCString());
  }

  // Last, so a throw above can't leave them on the 500
  reply.header('X-Content-Type-Options', 'nosniff');
  if (!isMedia(metadata.contentType)) {
    reply.header('Content-Security-Policy', contentSecurityPolicy);
  }
};
