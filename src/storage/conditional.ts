import type { IncomingHttpHeaders } from 'node:http';
import type { ByteRange, DeliveryHeaders } from './backend.js';

export type ResponsePlan = { status: 200 } | { status: 206; range: ByteRange } | { status: 304 } | { status: 416 };

const RANGE = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i;

/** A valid single `bytes` range of `size` bytes is 206, or 416 if none of it exists; anything else is ignored */
const resolveRange = (header: string, size: number): ResponsePlan => {
  const match = RANGE.exec(header);
  const [, first = '', last = ''] = match ?? [];
  const empty = first === '' && last === '';
  const inverted = first !== '' && last !== '' && Number(last) < Number(first);
  if (!match || empty || inverted) {
    return { status: 200 };
  }

  if (first === '') {
    const suffix = Number(last);

    return suffix === 0 || size === 0
      ? { status: 416 }
      : { status: 206, range: { start: Math.max(size - suffix, 0), end: size - 1 } };
  }

  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);

  return start >= size ? { status: 416 } : { status: 206, range: { start, end } };
};

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** Seconds since the epoch of an IMF-fixdate (RFC 9110 §5.6.7), or `undefined` for anything else */
const httpDate = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed || !IMF_FIXDATE.test(trimmed)) {
    return undefined;
  }
  const time = Date.parse(trimmed);

  return Number.isNaN(time) ? undefined : time / 1000;
};

/** RFC 9110 §13.1.5: a strong ETag match, or the exact date of a Last-Modified at least a second old */
const ifRangeHolds = (header: string, { etag, lastModified }: DeliveryHeaders, now: Date) => {
  const value = header.trim();
  if (value.startsWith('"')) {
    return etag !== undefined && !etag.startsWith('W/') && value === etag;
  }

  return (
    lastModified !== undefined &&
    httpDate(value) === seconds(lastModified) &&
    now.getTime() - lastModified.getTime() >= 1000
  );
};

const ENTITY_TAG = /(?:W\/)?"[^"]*"/g;
const opaqueTag = (etag: string) => etag.replace(/^W\//, '');

/** RFC 9110 §13.1.2 and §13.1.3: a weak match in `If-None-Match`, else `If-Modified-Since` at or after Last-Modified */
const notModified = (headers: IncomingHttpHeaders, { etag, lastModified }: DeliveryHeaders) => {
  const ifNoneMatch = headers['if-none-match'];
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() === '*') {
      return true;
    }

    return (
      etag !== undefined && (ifNoneMatch.match(ENTITY_TAG) ?? []).some((tag) => opaqueTag(tag) === opaqueTag(etag))
    );
  }

  const since = httpDate(headers['if-modified-since']);

  return lastModified !== undefined && since !== undefined && since >= seconds(lastModified);
};

/**
 * Decide how to answer a request for a delivery, from its conditional and `Range` headers
 */
export const planResponse = (
  headers: IncomingHttpHeaders,
  delivery: DeliveryHeaders,
  { ranges, now = new Date() }: { ranges: boolean; now?: Date },
): ResponsePlan => {
  if (notModified(headers, delivery)) {
    return { status: 304 };
  }

  const { range, 'if-range': ifRange } = headers;
  if (!ranges || !range) {
    return { status: 200 };
  }
  if (ifRange !== undefined && !(typeof ifRange === 'string' && ifRangeHolds(ifRange, delivery, now))) {
    return { status: 200 };
  }

  return resolveRange(range, delivery.contentLength);
};
