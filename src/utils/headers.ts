import type { FastifyReply } from 'fastify';
import type { DeliveryHeaders } from '../storage/backend.js';

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

/** The validators a 200 carries, which a 304 repeats */
export const setValidatorHeaders = (
  reply: FastifyReply,
  { etag, lastModified }: Pick<DeliveryHeaders, 'etag' | 'lastModified'>,
) => {
  if (etag) {
    reply.header('ETag', etag);
  }
  if (lastModified) {
    reply.header('Last-Modified', lastModified.toUTCString());
  }
};

export const setDeliveryHeaders = (
  reply: FastifyReply,
  metadata: { contentType: string; contentLength: number; etag?: string; lastModified?: Date },
) => {
  reply.header('Content-Type', metadata.contentType);
  reply.header('Content-Length', metadata.contentLength.toString());
  setValidatorHeaders(reply, metadata);

  // Last, so a throw above can't leave them on the 500
  reply.header('X-Content-Type-Options', 'nosniff');
  if (!isMedia(metadata.contentType)) {
    reply.header('Content-Security-Policy', contentSecurityPolicy);
  }
};
