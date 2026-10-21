import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { setFileHeaders } from '../utils/headers.js';
import type { MetadataDelivery } from './backend.js';

type SendOptions = {
  /** Overrides a `stream` or `path` delivery's Content-Type */
  contentType?: string;
  contentDisposition?: string;
  noRedirect?: boolean;
};

/**
 * Turn a delivery into the response, opening bytes only on GET so HEAD sends GET's headers alone
 * A `json` delivery is Metadata, so it is always sent as JSON-LD
 */
export const sendDelivery = async (
  request: FastifyRequest,
  reply: FastifyReply,
  delivery: MetadataDelivery,
  { contentType, contentDisposition, noRedirect = false }: SendOptions,
) => {
  if (delivery.type === 'redirect') {
    return noRedirect ? reply.code(200).send({ location: delivery.url }) : reply.redirect(delivery.url, 302);
  }

  const head = request.method === 'HEAD';

  if (delivery.type === 'json') {
    const body = Buffer.from(JSON.stringify(delivery.value));
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    setFileHeaders(reply, { contentType: 'application/ld+json', contentLength: body.length, etag });

    return reply.code(200).send(head ? undefined : body);
  }

  // Opened before any header is set, so a failure leaves a clean 500
  const body = head
    ? undefined
    : delivery.type === 'stream'
      ? await delivery.open()
      : (await open(delivery.path)).createReadStream();

  setFileHeaders(reply, { ...delivery, contentType: contentType ?? delivery.contentType });
  if (contentDisposition) {
    reply.header('Content-Disposition', contentDisposition);
  }

  return reply.code(200).send(body);
};
