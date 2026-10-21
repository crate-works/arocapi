import type { StorageBackend } from 'arocapi';
import { EntityMetaMetadata } from 'arocapi/storage/entity-meta';
import { OcflStorage } from 'arocapi/storage/ocfl';

const ocfl = await OcflStorage({ root: '/srv/ocfl' });

// Metadata from Entity.meta.rocrate, Content from the head version of each OCFL object
export const storage: StorageBackend = {
  metadata: EntityMetaMetadata(),
  content: ocfl.content,
};
