import type { StorageBackend } from 'arocapi';
import { DirectoryStorage } from 'arocapi/storage/directory';
import { EntityMetaMetadata } from 'arocapi/storage/entity-meta';

// Metadata kept in the database at Entity.meta.rocrate, Content on disk
export const storage: StorageBackend = {
  metadata: EntityMetaMetadata(),
  content: DirectoryStorage({ root: '/srv/archive' }).content,
};
