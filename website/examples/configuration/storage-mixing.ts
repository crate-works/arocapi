import type { MetadataSource, StorageBackend } from 'arocapi';
import { DirectoryStorage } from 'arocapi/storage/directory';

const directory = DirectoryStorage({ root: '/srv/archive' });

// Metadata kept in the database, Content on disk
const metadata: MetadataSource = (entity) => {
  const { rocrate } = (entity.meta ?? {}) as { rocrate?: object };

  return rocrate ? { type: 'json', value: rocrate } : null;
};

export const storage: StorageBackend = { metadata, content: directory.content };
