import type { Entity, File } from '../../generated/prisma/client.js';
import { metaValue } from '../../storage/location.js';
import type { AccessFunction } from '../../types/access.js';
import type { RequestContext } from '../../types/context.js';

/** An Entity row, an Object with no `meta` unless overridden */
export const entityRow = (overrides: Partial<Entity> = {}): Entity => ({
  id: 'http://example.com/item',
  name: 'Item',
  description: '',
  entityType: 'http://pcdm.org/models#Object',
  memberOf: null,
  rootCollection: null,
  metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
  contentLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
  meta: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** A File row with no `meta` unless overridden */
export const fileRow = (overrides: Partial<File> = {}): File => ({
  id: 'http://example.com/item',
  filename: 'item.wav',
  mediaType: 'audio/wav',
  size: BigInt(1),
  meta: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** Denies an entity whose `meta.accessControl` is `Restricted`, recording each row it is given */
export const restrictedByMeta =
  (rows: Entity[] = []): AccessFunction =>
  (_entity, _context, row) => {
    rows.push(row);
    const open = metaValue(row.meta, 'accessControl') !== 'Restricted';

    return { metadata: open, content: open };
  };

/** A transformer that records each row it is given and passes the item through */
export const recordRows =
  <Row>(rows: Row[]) =>
  <T>(item: T, _context: RequestContext, row: Row) => {
    rows.push(row);

    return item;
  };
