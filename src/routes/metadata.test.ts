import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import type { ContentSource, MetadataDelivery, MetadataSource } from '../storage/backend.js';
import { prisma } from '../test/helpers/fastify.js';
import { getAndHead } from '../test/helpers/getAndHead.js';
import { protectiveHeaders, sandboxed, unprotected } from '../test/helpers/protectiveHeaders.js';
import { entityRow } from '../test/helpers/rows.js';
import { buildStorageApp } from '../test/helpers/storageApp.js';
import type { StandardErrorResponse } from '../utils/errors.js';

const entity = entityRow({
  id: 'http://example.com/object',
  memberOf: 'http://example.com/collection',
  rootCollection: 'http://example.com/collection',
  meta: { storagePath: 'object/ro-crate-metadata.json' },
});

const url = `/entity/${encodeURIComponent(entity.id)}/metadata`;
const crate = '{"@context":"https://w3id.org/ro/crate/1.1/context"}';
const lastModified = new Date('2025-01-01T00:00:00Z');

describe('Metadata Route', () => {
  const metadata = vi.fn<MetadataSource>();
  const content = vi.fn<ContentSource>();
  let built: Awaited<ReturnType<typeof buildStorageApp>>;
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arocapi-metadata-'));
    await writeFile(join(dir, 'ro-crate-metadata.json'), crate);
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
    prisma.entity.findFirst.mockResolvedValue(entity);
  });

  const both = () => getAndHead((method) => app.inject({ method, url }));

  describe('path delivery', () => {
    it('opens the path on GET and sends the delivery headers as JSON-LD on GET and HEAD', async () => {
      metadata.mockResolvedValue({
        type: 'path',
        path: join(dir, 'ro-crate-metadata.json'),
        contentLength: crate.length,
        etag: 'W/"abc"',
        lastModified,
      });

      const { get, head } = await both();

      expect(get.statusCode).toBe(200);
      expect(get.body).toBe(crate);
      expect(get.headers['content-type']).toBe('application/ld+json');
      expect(get.headers['content-length']).toBe(String(crate.length));
      expect(get.headers.etag).toBe('W/"abc"');
      expect(get.headers['last-modified']).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
      expect(get.headers['content-disposition']).toBeUndefined();
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers).toEqual(get.headers);
    });

    it('answers 500 when the path cannot be opened', async () => {
      metadata.mockResolvedValue({
        type: 'path',
        path: join(dir, 'missing.json'),
        contentLength: 10,
      });

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(500);
      expect(response.json<StandardErrorResponse>().error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('stream delivery', () => {
    it('opens the stream only on GET, making one call per request', async () => {
      const open = vi.fn(() => Readable.from([crate]));
      metadata.mockReturnValue({ type: 'stream', open, contentLength: crate.length });

      const head = await app.inject({ method: 'HEAD', url });

      expect(head.statusCode).toBe(200);
      expect(head.headers['content-length']).toBe(String(crate.length));
      expect(head.headers.etag).toBeUndefined();
      expect(head.headers['last-modified']).toBeUndefined();
      expect(metadata).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();

      const get = await app.inject({ method: 'GET', url });

      expect(get.body).toBe(crate);
      expect(get.headers['content-type']).toBe('application/ld+json');
      expect(metadata).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledOnce();
    });
  });

  describe('redirect delivery', () => {
    it('answers 302 on GET and HEAD', async () => {
      metadata.mockResolvedValue({ type: 'redirect', url: 'https://storage.example.com/ro-crate-metadata.json' });

      const { get, head } = await both();

      expect(get.statusCode).toBe(302);
      expect(get.headers.location).toBe('https://storage.example.com/ro-crate-metadata.json');
      expect(head.statusCode).toBe(302);
      expect(head.headers.location).toBe('https://storage.example.com/ro-crate-metadata.json');
    });
  });

  describe('json delivery', () => {
    const json = (value: unknown): MetadataDelivery => ({ type: 'json', value });

    it('serialises the value once, with the byte length and a strong ETag, on GET and HEAD', async () => {
      metadata.mockResolvedValue(json({ name: 'Ŋaŋa' }));

      const { get, head } = await both();

      expect(get.statusCode).toBe(200);
      expect(get.body).toBe('{"name":"Ŋaŋa"}');
      expect(get.headers['content-type']).toBe('application/ld+json');
      expect(get.headers['content-length']).toBe('17');
      expect(get.headers.etag).toMatch(/^"[^"]+"$/);
      expect(head.body).toBe('');
      expect(head.headers).toEqual(get.headers);
    });

    it('gives different values different ETags', async () => {
      metadata.mockResolvedValueOnce(json({ name: 'a' })).mockResolvedValueOnce(json({ name: 'b' }));

      const { get: first, head: second } = await both();

      expect(first.headers.etag).not.toBe(second.headers.etag);
    });
  });

  describe('protective headers', () => {
    it.each<[string, () => MetadataDelivery]>([
      ['json', () => ({ type: 'json', value: { name: 'a' } })],
      ['stream', () => ({ type: 'stream', open: () => Readable.from([crate]), contentLength: crate.length })],
    ])('sandboxes a %s delivery on GET and HEAD', async (_, delivery) => {
      metadata.mockImplementation(delivery);

      const { get, head } = await both();

      for (const response of [get, head]) {
        expect(response.statusCode).toBe(200);
        expect(protectiveHeaders(response)).toEqual(sandboxed);
      }
    });

    it('adds neither to a redirect delivery, a 404 or a 500', async () => {
      metadata
        .mockResolvedValueOnce({ type: 'redirect', url: 'https://storage.example.com/ro-crate-metadata.json' })
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('Storage is unreachable'));

      const responses = [
        await app.inject({ method: 'GET', url }),
        await app.inject({ method: 'GET', url }),
        await app.inject({ method: 'GET', url }),
      ];

      expect(responses.map((response) => response.statusCode)).toEqual([302, 404, 500]);
      for (const response of responses) {
        expect(protectiveHeaders(response)).toEqual(unprotected);
      }
    });
  });

  it('answers 404 when the half returns null', async () => {
    metadata.mockReturnValue(null);

    const { get, head } = await both();

    expect(get.statusCode).toBe(404);
    expect(get.json<StandardErrorResponse>().error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'The requested Metadata was not found',
    });
    expect(head.statusCode).toBe(404);
  });

  it('answers a logged 500 for a delivery type it does not know', async () => {
    metadata.mockReturnValue({ type: 'inline', value: {} } as unknown as MetadataDelivery);

    const { get, head } = await both();

    expect(get.statusCode).toBe(500);
    expect(head.statusCode).toBe(500);
    expect(built.errors[0]?.err?.message).toContain('a delivery of type "inline"');
  });

  it('answers a logged 500 when the half throws', async () => {
    metadata.mockRejectedValue(new Error('Storage is unreachable'));

    const { get, head } = await both();

    expect(get.statusCode).toBe(500);
    expect(get.json<StandardErrorResponse>().error.code).toBe('INTERNAL_ERROR');
    expect(get.body).not.toContain('unreachable');
    expect(head.statusCode).toBe(500);
    expect(built.errors.map((line) => line.err?.message)).toEqual(['Storage is unreachable', 'Storage is unreachable']);
  });

  it('passes the entity, with its meta, and the request context', async () => {
    metadata.mockReturnValue(null);

    await app.inject({ method: 'GET', url });

    expect(metadata).toHaveBeenCalledWith(
      entity,
      expect.objectContaining({ request: expect.any(Object), fastify: expect.any(Object) }),
    );
    expect(content).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'] as const)(
    'refuses %s before calling the half when the Metadata is denied',
    async (method) => {
      built.access.mockReturnValue({ metadata: false, content: true });

      const response = await app.inject({ method, url });

      expect(response.statusCode).toBe(403);
      expect(metadata).not.toHaveBeenCalled();
    },
  );

  it('serves the Metadata when only the Content is denied', async () => {
    built.access.mockReturnValue({ metadata: true, content: false });
    metadata.mockReturnValue({ type: 'redirect', url: 'https://storage.example.com/crate' });

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(302);
  });

  it.each(['GET', 'HEAD'] as const)('answers %s for an entity that is not visible with 404', async (method) => {
    prisma.entity.findFirst.mockResolvedValue(null);

    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(404);
    expect(metadata).not.toHaveBeenCalled();
  });

  it('decides access on the entity without looking up its parents', async () => {
    metadata.mockReturnValue(null);

    await app.inject({ method: 'GET', url });

    expect(built.access).toHaveBeenCalledWith(
      expect.objectContaining({ id: entity.id, memberOf: entity.memberOf }),
      expect.any(Object),
    );
    expect(prisma.entity.findMany).not.toHaveBeenCalled();
  });

  it('validates the id', async () => {
    const response = await app.inject({ method: 'GET', url: '/entity/invalid-id/metadata' });

    expect(response.statusCode).toBe(400);
    expect(response.json<StandardErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });
});
