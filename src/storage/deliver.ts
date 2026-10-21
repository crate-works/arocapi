import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { setFileHeaders } from '../utils/headers.js';
import type { ContentDelivery, JsonDelivery } from './backend.js';

type SendOptions = {
  contentDisposition?: string;
  noRedirect?: boolean;
  /** Whether a `json` delivery may be sent: Metadata's only */
  json?: boolean;
};

/** A delivery with its Content-Type settled: Content's own, or the one the Metadata route gives */
type TypedDelivery = ContentDelivery | (JsonDelivery & { contentType: string });

/**
 * Turn a delivery into the response, opening bytes only on GET so HEAD sends GET's headers alone
 * Throws on a delivery type the caller doesn't take, as a half typed loosely at runtime could return one
 */
export const sendDelivery = async (
  request: FastifyRequest,
  reply: FastifyReply,
  delivery: TypedDelivery,
  { contentDisposition, noRedirect = false, json = false }: SendOptions = {},
) => {
  if (delivery.type === 'redirect') {
    return noRedirect ? reply.code(200).send({ location: delivery.url }) : reply.redirect(delivery.url, 302);
  }

  const head = request.method === 'HEAD';

  if (delivery.type === 'json' && json) {
    const body = Buffer.from(JSON.stringify(delivery.value));
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    setFileHeaders(reply, { contentType: delivery.contentType, contentLength: body.length, etag });

    return reply.code(200).send(head ? undefined : body);
  }

  if (delivery.type !== 'stream' && delivery.type !== 'path') {
    throw new Error(
      `Storage returned a delivery of type ${JSON.stringify(delivery.type)}, which this route can't send`,
    );
  }

  // Opened before any header is set, so a failure leaves a clean 500
  let body: Readable | undefined;
  if (!head) {
    body = delivery.type === 'stream' ? await delivery.open() : (await open(delivery.path)).createReadStream();
  }

  try {
    setFileHeaders(reply, delivery);
  } catch (error) {
    body?.destroy();
    throw error;
  }
  if (contentDisposition) {
    reply.header('Content-Disposition', contentDisposition);
  }

  return reply.code(200).send(body);
};
