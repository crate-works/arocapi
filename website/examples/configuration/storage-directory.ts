import { DirectoryStorage } from 'arocapi/storage/directory';

// Metadata from Entity.meta.storagePath and Content from File.meta.storagePath, both below root
export const storage = DirectoryStorage({ root: '/srv/archive' });

// Or derive each location yourself, ignoring meta
export const located = DirectoryStorage({
  root: '/srv/archive',
  locate: {
    metadata: (entity) => `${new URL(entity.id).pathname.slice(1)}/ro-crate-metadata.json`,
    content: (file, entity) =>
      entity.memberOf ? `${new URL(entity.memberOf).pathname.slice(1)}/${file.filename}` : null,
  },
});
