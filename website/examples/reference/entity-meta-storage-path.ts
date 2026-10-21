import type { DirectoryStorageMeta } from 'arocapi';
import type { PrismaClient } from './generated/prisma/client.ts';

declare const prisma: PrismaClient;

// Index the item's crate and file with the keys DirectoryStorage reads, relative to its root
await prisma.entity.update({
  where: { id: 'https://example.org/item' },
  data: { meta: { storagePath: 'item/ro-crate-metadata.json' } satisfies DirectoryStorageMeta },
});
await prisma.file.update({
  where: { id: 'https://example.org/item/song.wav' },
  data: { meta: { storagePath: 'item/song.wav' } satisfies DirectoryStorageMeta },
});
