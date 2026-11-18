import { describe, expect, it } from 'vitest';
import { planResponse } from './conditional.js';

const size = 100;
const plan = (headers: Record<string, string>) => planResponse(headers, { contentLength: size }, { ranges: true });

describe('planResponse', () => {
  describe('Range', () => {
    it('sends the whole Content without a Range header', () => {
      expect(plan({})).toEqual({ status: 200 });
    });

    it.each([
      ['bytes=0-9', { start: 0, end: 9 }],
      ['bytes=10-', { start: 10, end: 99 }],
      ['bytes=-10', { start: 90, end: 99 }],
      ['bytes=90-200', { start: 90, end: 99 }],
      ['bytes=-200', { start: 0, end: 99 }],
      ['bytes=99-99', { start: 99, end: 99 }],
      ['BYTES=0-9', { start: 0, end: 9 }],
      ['bytes= 0-9 ', { start: 0, end: 9 }],
    ])('serves %s as %j', (range, expected) => {
      expect(plan({ range })).toEqual({ status: 206, range: expected });
    });

    it.each(['bytes=', 'bytes=-', 'bytes=a-b', 'bytes=9-0', 'bytes=0-1,5-9', 'bytes=1.5-2', 'items=0-9', '0-9'])(
      'ignores %j and sends the whole Content',
      (range) => {
        expect(plan({ range })).toEqual({ status: 200 });
      },
    );

    it.each(['bytes=100-', 'bytes=150-200', 'bytes=-0'])('refuses %s as not satisfiable', (range) => {
      expect(plan({ range })).toEqual({ status: 416 });
    });

    it.each(['bytes=0-9', 'bytes=-10', 'bytes=0-'])('refuses %s on empty Content', (range) => {
      expect(planResponse({ range }, { contentLength: 0 }, { ranges: true })).toEqual({ status: 416 });
    });

    it('ignores Range where ranges are not served', () => {
      expect(planResponse({ range: 'bytes=0-9' }, { contentLength: size }, { ranges: false })).toEqual({
        status: 200,
      });
    });
  });

  describe('If-Range', () => {
    const lastModified = new Date('2025-01-01T00:00:00.400Z');
    const httpDate = 'Wed, 01 Jan 2025 00:00:00 GMT';
    const now = new Date('2025-06-01T00:00:00Z');
    const ranged = (ifRange: string, delivery: { etag?: string; lastModified?: Date }, at = now) =>
      planResponse(
        { range: 'bytes=0-9', 'if-range': ifRange },
        { contentLength: size, ...delivery },
        {
          ranges: true,
          now: at,
        },
      );

    it('serves the range when it names the strong ETag', () => {
      expect(ranged('"abc"', { etag: '"abc"' })).toEqual({ status: 206, range: { start: 0, end: 9 } });
    });

    it.each([
      ['another ETag', '"xyz"', { etag: '"abc"' }],
      ['a weak ETag', 'W/"abc"', { etag: 'W/"abc"' }],
      ['the ETag of a weak delivery ETag', '"abc"', { etag: 'W/"abc"' }],
      ['an ETag when the delivery has none', '"abc"', {}],
      ['an earlier date', 'Tue, 31 Dec 2024 00:00:00 GMT', { lastModified }],
      ['a date when the delivery has none', httpDate, { etag: '"abc"' }],
      ['an unparseable value', 'yesterday', { lastModified }],
      ['an ISO date that is not an HTTP date', '2025-01-01T00:00:00Z', { lastModified }],
    ])('sends the whole Content for %s', (_name, ifRange, delivery) => {
      expect(ranged(ifRange, delivery)).toEqual({ status: 200 });
    });

    it('serves the range when the date is the Last-Modified, to the second', () => {
      expect(ranged(httpDate, { etag: 'W/"abc"', lastModified })).toEqual({ status: 206, range: { start: 0, end: 9 } });
    });

    it('sends the whole Content when the Last-Modified is under a second old', () => {
      expect(ranged(httpDate, { lastModified }, new Date('2025-01-01T00:00:01.200Z'))).toEqual({ status: 200 });
    });

    it('is ignored without a Range header', () => {
      expect(planResponse({ 'if-range': '"abc"' }, { contentLength: size, etag: '"abc"' }, { ranges: true })).toEqual({
        status: 200,
      });
    });

    it('sends the whole Content rather than a 416 when it does not match', () => {
      expect(
        planResponse(
          { range: 'bytes=500-', 'if-range': '"old"' },
          { contentLength: size, etag: '"new"' },
          { ranges: true, now },
        ),
      ).toEqual({ status: 200 });
    });
  });

  describe('Not Modified', () => {
    const lastModified = new Date('2025-01-01T00:00:00.400Z');
    const delivery = { contentLength: size, etag: '"abc"', lastModified };
    const conditional = (headers: Record<string, string>, from: Partial<typeof delivery> = delivery) =>
      planResponse(headers, { contentLength: size, ...from }, { ranges: false });

    it.each([
      ['the ETag', '"abc"'],
      ['the ETag, weakly', 'W/"abc"'],
      ['the ETag in a list', '"xyz", W/"abc"'],
      ['any ETag', '*'],
    ])('answers 304 when If-None-Match names %s', (_name, ifNoneMatch) => {
      expect(conditional({ 'if-none-match': ifNoneMatch })).toEqual({ status: 304 });
    });

    it('matches a weak delivery ETag', () => {
      expect(conditional({ 'if-none-match': '"abc"' }, { etag: 'W/"abc"' })).toEqual({ status: 304 });
    });

    it.each([
      ['another ETag', { 'if-none-match': '"xyz"' }, delivery],
      ['an If-None-Match with no ETag in it', { 'if-none-match': 'abc' }, delivery],
      ['an ETag when the delivery has none', { 'if-none-match': '"abc"' }, { lastModified }],
      ['an earlier date', { 'if-modified-since': 'Tue, 31 Dec 2024 23:59:59 GMT' }, delivery],
      ['an unparseable date', { 'if-modified-since': 'yesterday' }, delivery],
      ['a year that is not an HTTP date', { 'if-modified-since': '2099' }, delivery],
      ['an HTTP date that does not exist', { 'if-modified-since': 'Wed, 45 Foo 2025 00:00:00 GMT' }, delivery],
      ['an ISO date that is not an HTTP date', { 'if-modified-since': '2099-01-01' }, delivery],
      [
        'a date when the delivery has none',
        { 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' },
        { etag: '"abc"' },
      ],
      [
        'a matching date beside a mismatched ETag',
        { 'if-none-match': '"xyz"', 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' },
        delivery,
      ],
    ])('sends the Content for %s', (_name, headers, from) => {
      expect(conditional(headers, from)).toEqual({ status: 200 });
    });

    it.each(['Wed, 01 Jan 2025 00:00:00 GMT', 'Thu, 02 Jan 2025 00:00:00 GMT'])(
      'answers 304 when If-Modified-Since is %s, at or after the Last-Modified',
      (ifModifiedSince) => {
        expect(conditional({ 'if-modified-since': ifModifiedSince })).toEqual({ status: 304 });
      },
    );

    it('answers 304 before considering Range', () => {
      expect(planResponse({ 'if-none-match': '"abc"', range: 'bytes=500-' }, delivery, { ranges: true })).toEqual({
        status: 304,
      });
    });
  });
});
