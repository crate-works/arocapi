import type { Entity, File } from '../../generated/prisma/client.js';

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
