import { describe, expect, it } from 'vitest';
import { entityRow } from '../../test/helpers/rows.js';
import type { RequestContext } from '../../types/context.js';
import { EntityMetaMetadata } from './entity-meta.js';

const entity = entityRow();

const context = {} as RequestContext;

const crate = { '@context': 'https://w3id.org/ro/crate/1.2/context', '@graph': [] };

describe('EntityMetaMetadata', () => {
  it('delivers meta.rocrate as json', async () => {
    const metadata = EntityMetaMetadata();

    await expect(metadata({ ...entity, meta: { rocrate: crate } }, context)).resolves.toEqual({
      type: 'json',
      value: crate,
    });
  });

  it('reads a custom key', async () => {
    const metadata = EntityMetaMetadata({ key: 'crate' });

    await expect(metadata({ ...entity, meta: { crate, rocrate: 'ignored' } }, context)).resolves.toEqual({
      type: 'json',
      value: crate,
    });
  });

  it.each([null, ['rocrate'], 'rocrate', {}, { crate }])('finds nothing when meta is %j', async (meta) => {
    const metadata = EntityMetaMetadata();

    await expect(metadata({ ...entity, meta }, context)).resolves.toBeNull();
  });

  it.each(['{"@graph":[]}', [crate], 42, true, null])(
    'throws naming the entity and key when rocrate is %j',
    async (rocrate) => {
      const metadata = EntityMetaMetadata();

      await expect(metadata({ ...entity, meta: { rocrate } }, context)).rejects.toThrow(
        'http://example.com/item has a meta.rocrate that is not a JSON object',
      );
    },
  );

  it('names a custom key when its value is not an object', async () => {
    const metadata = EntityMetaMetadata({ key: 'crate' });

    await expect(metadata({ ...entity, meta: { crate: [] } }, context)).rejects.toThrow(
      'http://example.com/item has a meta.crate that is not a JSON object',
    );
  });
});
