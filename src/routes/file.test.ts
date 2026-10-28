import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import type { File } from '../generated/prisma/client.js';
import type { ContentDelivery, ContentSource, MetadataSource } from '../storage/backend.js';
import { prisma } from '../test/helpers/fastify.js';
import { getAndHead } from '../test/helpers/getAndHead.js';
import { mediaOnly, protectiveHeaders, sandboxed, unprotected } from '../test/helpers/protectiveHeaders.js';
import { entityRow, fileRow } from '../test/helpers/rows.js';
import { buildStorageApp } from '../test/helpers/storageApp.js';
import type { StandardErrorResponse } from '../utils/errors.js';

const entity = entityRow({
  id: 'http://example.com/file/test.wav',
  name: 'test.wav',
  entityType: 'http://schema.org/MediaObject',
  memberOf: 'http://example.com/object',
  rootCollection: 'http://example.com/collection',
  contentLicenseId: 'https://example.com/licence/restricted',
  meta: { ocflObject: 'http://example.com/object' },
});

const file = fileRow({
  id: entity.id,
  filename: 'test.wav',
  size: BigInt(999999),
  meta: { storagePath: 'object/test.wav' },
});

// findFirst's mock is typed without the include
const withEntity = (row: File) => ({ ...row, entity }) as File;

const url = `/file/${encodeURIComponent(file.id)}`;
const bytes = 'RIFF audio bytes';
const lastModified = new Date('2025-01-01T00:00:00Z');

describe('File Route', () => {
  const metadata = vi.fn<MetadataSource>();
  const content = vi.fn<ContentSource>();
  let built: Awaited<ReturnType<typeof buildStorageApp>>;
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arocapi-file-'));
    await writeFile(join(dir, 'test.wav'), bytes);
    built = await buildStorageApp({ metadata, content });
    app = built.app;
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true });
  });

  beforeEach(() => {
    mockReset(prisma);
    metadata.mockReset();
    content.mockReset();
    built.access.mockReset();
    built.errors.length = 0;
    prisma.file.findFirst.mockResolvedValue(withEntity(file));
  });

  const both = (query = '') => getAndHead((method) => app.inject({ method, url: `${url}${query}` }));

  describe('path delivery', () => {
    it('opens the path on GET and sends the delivery headers on GET and HEAD, never File.size', async () => {
      content.mockResolvedValue({
        type: 'path',
        path: join(dir, 'test.wav'),
        contentType: 'audio/x-wav',
        contentLength: bytes.length,
        etag: 'W/"abc"',
        lastModified,
      });

      const { get, head } = await both();

      expect(get.statusCode).toBe(200);
      expect(get.body).toBe(bytes);
      expect(get.headers['content-type']).toBe('audio/x-wav');
      expect(get.headers['content-length']).toBe(String(bytes.length));
      expect(get.headers.etag).toBe('W/"abc"');
      expect(get.headers['last-modified']).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
      expect(get.headers['content-disposition']).toBe('inline; filename=test.wav');
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers).toEqual(get.headers);
    });

    it('answers a clean 500 when the path cannot be opened', async () => {
      content.mockResolvedValue({
        type: 'path',
        path: join(dir, 'missing.wav'),
        contentType: 'audio/wav',
        contentLength: 10,
      });

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(500);
      expect(response.json<StandardErrorResponse>().error.code).toBe('INTERNAL_ERROR');
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.headers['content-type']).toContain('application/json');
    });
  });

  describe('stream delivery', () => {
    it('opens the stream only on GET, making one call per request', async () => {
      const open = vi.fn(async () => Readable.from([bytes]));
      content.mockReturnValue({ type: 'stream', open, contentType: 'audio/wav', contentLength: bytes.length });

      const head = await app.inject({ method: 'HEAD', url });

      expect(head.statusCode).toBe(200);
      expect(head.headers['content-type']).toBe('audio/wav');
      expect(head.headers['content-length']).toBe(String(bytes.length));
      expect(content).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();

      const get = await app.inject({ method: 'GET', url });

      expect(get.body).toBe(bytes);
      expect(get.headers).toEqual(head.headers);
      expect(content).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledOnce();
    });

    it('destroys the opened stream when its headers cannot be set', async () => {
      const stream = Readable.from([bytes]);
      content.mockReturnValue({ type: 'stream', open: () => stream, contentType: 'audio/wav' } as ContentDelivery);

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(500);
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(stream.destroyed).toBe(true);
    });
  });

  describe('protective headers', () => {
    const withType = (type: 'stream' | 'path', contentType: string): ContentDelivery =>
      type === 'stream'
        ? { type, open: () => Readable.from([bytes]), contentType, contentLength: bytes.length }
        : { type, path: join(dir, 'test.wav'), contentType, contentLength: bytes.length };

    describe.each(['stream', 'path'] as const)('%s delivery', (type) => {
      it.each([
        'text/html',
        'image/svg+xml',
        'application/pdf',
        'application/octet-stream',
        // Browsers take the last type in a list, so these must not pass as media
        'audio/mpeg, text/html',
        'audio/mpeg;x=1, text/html',
        'video/mp4,text/html',
        ' audio/mpeg',
        'audio/',
        'audio/mpeg; x="a", text/html',
      ])('sandboxes %s on GET and HEAD', async (contentType) => {
        content.mockImplementation(() => withType(type, contentType));

        const { get, head } = await both();

        for (const response of [get, head]) {
          expect(response.statusCode).toBe(200);
          expect(protectiveHeaders(response)).toEqual(sandboxed);
        }
      });

      it.each([
        'audio/wav',
        'video/mp4',
        'audio/ogg; codecs=opus',
        'Video/MP4',
        'AUDIO/Mpeg;rate=44100',
        'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        'audio/ogg; codecs="opus,vorbis"',
      ])('sends %s with nosniff and no CSP on GET and HEAD', async (contentType) => {
        content.mockImplementation(() => withType(type, contentType));

        const { get, head } = await both();

        for (const response of [get, head]) {
          expect(response.statusCode).toBe(200);
          expect(protectiveHeaders(response)).toEqual(mediaOnly);
        }
      });
    });

    it.each(['', '?noRedirect=true'])('adds neither to a redirect delivery when the query is %j', async (query) => {
      content.mockResolvedValue({ type: 'redirect', url: 'https://storage.example.com/test.html' });

      const { get, head } = await both(query);

      for (const response of [get, head]) {
        expect(protectiveHeaders(response)).toEqual(unprotected);
      }
    });

    it('adds neither to a 404 or a 500', async () => {
      content.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Storage is unreachable'));

      const missing = await app.inject({ method: 'GET', url });
      const failed = await app.inject({ method: 'GET', url });

      expect(missing.statusCode).toBe(404);
      expect(failed.statusCode).toBe(500);
      for (const response of [missing, failed]) {
        expect(protectiveHeaders(response)).toEqual(unprotected);
      }
    });

    it('lets a consumer onSend hook replace the CSP', async () => {
      const custom = await buildStorageApp({ metadata, content }, (instance) => {
        instance.addHook('onSend', async (_request, reply, payload) => {
          if (reply.hasHeader('content-security-policy')) {
            reply.header('Content-Security-Policy', 'sandbox allow-scripts');
          }
          return payload;
        });
      });
      content.mockImplementation(() => withType('stream', 'text/html'));

      onTestFinished(() => custom.app.close());

      const response = await custom.app.inject({ method: 'GET', url });

      expect(protectiveHeaders(response)).toEqual({ csp: 'sandbox allow-scripts', nosniff: 'nosniff' });
    });

    it('adds neither to the 500 when Last-Modified cannot be set', async () => {
      content.mockReturnValue({
        ...withType('stream', 'text/html'),
        lastModified: '2024-01-01' as unknown as Date,
      } as ContentDelivery);

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(500);
      expect(protectiveHeaders(response)).toEqual(unprotected);
    });
  });

  it.each([
    ['json', { type: 'json', value: {}, contentType: 'application/json' }],
    ['unknown', { type: 'inline', contentType: 'audio/wav', contentLength: 1 }],
  ])('answers a logged 500 for a %s delivery', async (_, delivery) => {
    content.mockReturnValue(delivery as unknown as ContentDelivery);

    const { get, head } = await both();

    expect(get.statusCode).toBe(500);
    expect(head.statusCode).toBe(500);
    expect(built.errors[0]?.err?.message).toContain(`a delivery of type "${delivery.type}"`);
  });

  describe('redirect delivery', () => {
    beforeEach(() => {
      content.mockResolvedValue({ type: 'redirect', url: 'https://storage.example.com/test.wav' });
    });

    it.each(['', '?noRedirect=false'])('answers 302 on GET and HEAD when the query is %j', async (query) => {
      const { get, head } = await both(query);

      expect(get.statusCode).toBe(302);
      expect(get.headers.location).toBe('https://storage.example.com/test.wav');
      expect(get.headers['content-disposition']).toBeUndefined();
      expect(head.statusCode).toBe(302);
      expect(head.headers.location).toBe('https://storage.example.com/test.wav');
    });

    it('answers 200 with the location under noRedirect', async () => {
      const { get, head } = await both('?noRedirect=true');

      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ location: 'https://storage.example.com/test.wav' });
      expect(head.statusCode).toBe(200);
      expect(head.headers.location).toBeUndefined();
    });

    it.each(['', '1', 'TRUE', 'yes'])('rejects noRedirect=%j before calling the half', async (value) => {
      const response = await app.inject({ method: 'GET', url: `${url}?noRedirect=${value}` });

      expect(response.statusCode).toBe(400);
      expect(response.json<StandardErrorResponse>().error.code).toBe('VALIDATION_ERROR');
      expect(content).not.toHaveBeenCalled();
    });
  });

  describe('contentDisposition', () => {
    const stream = () => ({
      type: 'stream' as const,
      open: () => Readable.from(['x']),
      contentType: 'audio/wav',
      contentLength: 1,
    });

    it.each([
      { name: 'inline with the stored filename', stored: 'test.wav', query: '', expected: 'inline; filename=test.wav' },
      {
        name: 'an attachment',
        stored: 'test.wav',
        query: '?disposition=attachment',
        expected: 'attachment; filename=test.wav',
      },
      {
        name: 'a custom filename',
        stored: 'test.wav',
        query: '?filename=custom-name.wav',
        expected: 'inline; filename=custom-name.wav',
      },
      {
        name: 'a non-Latin stored filename',
        stored: 'ŋaŋa.wav',
        query: '',
        expected: `inline; filename="?a?a.wav"; filename*=UTF-8''%C5%8Ba%C5%8Ba.wav`,
      },
      {
        name: 'quotes in a custom filename',
        stored: 'test.wav',
        query: `?filename=${encodeURIComponent(`a"; filename*=UTF-8''evil.html`)}`,
        expected: `inline; filename="a\\"; filename*=UTF-8''evil.html"`,
      },
      {
        name: 'backslashes in a stored filename',
        stored: 'back\\slash.wav',
        query: '',
        expected: 'inline; filename="back\\\\slash.wav"',
      },
    ])('passes and sends $name', async ({ stored, query, expected }) => {
      prisma.file.findFirst.mockResolvedValue(withEntity({ ...file, filename: stored }));
      content.mockImplementation(stream);

      const { get, head } = await both(query);

      expect(get.headers['content-disposition']).toBe(expected);
      expect(head.headers['content-disposition']).toBe(expected);
      expect(content).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ contentDisposition: expected }),
      );
    });

    it('rejects an unknown disposition', async () => {
      const response = await app.inject({ method: 'GET', url: `${url}?disposition=invalid` });

      expect(response.statusCode).toBe(400);
      expect(response.json<StandardErrorResponse>().error.code).toBe('VALIDATION_ERROR');
    });
  });

  it('passes the file, its entity with meta, and the request context', async () => {
    content.mockReturnValue(null);

    await app.inject({ method: 'GET', url });

    expect(content).toHaveBeenCalledWith(
      file,
      entity,
      expect.objectContaining({ request: expect.any(Object), fastify: expect.any(Object) }),
    );
    expect(metadata).not.toHaveBeenCalled();
  });

  it('answers 404 when the half returns null', async () => {
    content.mockResolvedValue(null);

    const { get, head } = await both();

    expect(get.statusCode).toBe(404);
    expect(get.json<StandardErrorResponse>().error.code).toBe('NOT_FOUND');
    expect(head.statusCode).toBe(404);
  });

  it('answers a logged 500 when the half throws', async () => {
    content.mockImplementation(() => {
      throw new Error('Storage is unreachable');
    });

    const { get, head } = await both();

    expect(get.statusCode).toBe(500);
    expect(get.json<StandardErrorResponse>().error.code).toBe('INTERNAL_ERROR');
    expect(get.body).not.toContain('unreachable');
    expect(head.statusCode).toBe(500);
    expect(built.errors.map((line) => line.err?.message)).toEqual(['Storage is unreachable', 'Storage is unreachable']);
  });

  it.each(['GET', 'HEAD'] as const)('refuses %s before calling the half when the Content is denied', async (method) => {
    built.access.mockReturnValue({ metadata: true, content: false });

    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(403);
    expect(content).not.toHaveBeenCalled();
  });

  it('serves the Content when only the Metadata is denied', async () => {
    built.access.mockReturnValue({ metadata: false, content: true });
    content.mockReturnValue({ type: 'redirect', url: 'https://example.com/test.wav' });

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(302);
  });

  it('decides access on the file entity without looking up its parents', async () => {
    content.mockReturnValue(null);

    await app.inject({ method: 'GET', url });

    expect(built.access).toHaveBeenCalledWith(
      expect.objectContaining({ id: entity.id, contentLicenseId: entity.contentLicenseId }),
      expect.any(Object),
    );
    expect(prisma.entity.findMany).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'] as const)('answers %s for a file that is not visible with 404', async (method) => {
    prisma.file.findFirst.mockResolvedValue(null);

    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(404);
    expect(content).not.toHaveBeenCalled();
  });

  it('answers 500 when the database fails', async () => {
    prisma.file.findFirst.mockRejectedValue(new Error('Database connection failed'));

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(500);
  });

  it('validates the id', async () => {
    const response = await app.inject({ method: 'GET', url: '/file/invalid-id' });

    expect(response.statusCode).toBe(400);
  });
});
