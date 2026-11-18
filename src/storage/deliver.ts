import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createError, ERROR_CODES } from '../utils/errors.js';
import { setDeliveryHeaders, setValidatorHeaders } from '../utils/headers.js';
import type {
  ByteRange,
  ContentDelivery,
  DeliveryHeaders,
  JsonDelivery,
  MaybePromise,
  RedirectDelivery,
} from './backend.js';
import { planResponse } from './conditional.js';

type SendOptions = {
  /** Metadata may be sent as `json`; Content serves byte ranges and carries a disposition */
  item: 'content' | 'metadata';
  contentDisposition?: string;
  noRedirect?: boolean;
};

/** A delivery with its Content-Type settled: Content's own, or the one the Metadata route gives */
type TypedDelivery = ContentDelivery | (JsonDelivery & { contentType: string });

/** A delivery's headers, and how to read any range of its bytes */
type Representation = DeliveryHeaders & { contentType: string; read: (range: ByteRange) => MaybePromise<Readable> };

const sendNotSatisfiable = (reply: FastifyReply, { contentLength }: DeliveryHeaders) =>
  reply
    .code(416)
    .header('Content-Range', `bytes */${contentLength}`)
    .send(createError(ERROR_CODES.RANGE_NOT_SATISFIABLE, 'The requested range is not satisfiable'));

/**
 * Throws on a delivery type the caller doesn't take, as a half typed loosely at runtime could return one
 */
const toRepresentation = (delivery: Exclude<TypedDelivery, RedirectDelivery>, json: boolean): Representation => {
  if (delivery.type === 'json' && json) {
    const body = Buffer.from(JSON.stringify(delivery.value));
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;

    return {
      contentType: delivery.contentType,
      contentLength: body.length,
      etag,
      read: ({ start, end }) => Readable.from([body.subarray(start, end + 1)]),
    };
  }
  if (delivery.type === 'stream') {
    return { ...delivery, read: delivery.open };
  }
  if (delivery.type === 'path') {
    return { ...delivery, read: async (range) => (await open(delivery.path)).createReadStream(range) };
  }

  throw new Error(`Storage returned a delivery of type ${JSON.stringify(delivery.type)}, which this route can't send`);
};

/**
 * Turn a delivery into the response, reading bytes only on GET so HEAD sends GET's headers alone
 * Answers conditional requests, and byte ranges on Content, before reading anything
 */
export const sendDelivery = async (
  request: FastifyRequest,
  reply: FastifyReply,
  delivery: TypedDelivery,
  { item, contentDisposition, noRedirect = false }: SendOptions,
) => {
  if (delivery.type === 'redirect') {
    return noRedirect ? reply.code(200).send({ location: delivery.url }) : reply.redirect(delivery.url, 302);
  }

  const head = request.method === 'HEAD';
  const ranges = item === 'content';
  const representation = toRepresentation(delivery, item === 'metadata');
  const plan = planResponse(request.headers, representation, { ranges: ranges && !head });
  if (plan.status === 304) {
    setValidatorHeaders(reply, representation);

    return reply.code(304).send();
  }
  if (plan.status === 416) {
    return sendNotSatisfiable(reply, representation);
  }

  const { contentLength } = representation;
  const partial = plan.status === 206 ? plan.range : undefined;

  // Read before any header is set, so a failure leaves a clean 500
  let body: Readable | undefined;
  if (!head && contentLength !== 0) {
    body = await representation.read(partial ?? { start: 0, end: contentLength - 1 });
  }

  try {
    setDeliveryHeaders(
      reply,
      partial ? { ...representation, contentLength: partial.end - partial.start + 1 } : representation,
    );
  } catch (error) {
    body?.destroy();
    throw error;
  }
  if (contentDisposition) {
    reply.header('Content-Disposition', contentDisposition);
  }
  if (ranges) {
    reply.header('Accept-Ranges', 'bytes');
  }
  if (partial) {
    reply.header('Content-Range', `bytes ${partial.start}-${partial.end}/${contentLength}`);
  }

  return reply.code(plan.status).send(body ?? (head ? undefined : ''));
};
