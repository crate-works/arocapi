import { DirectoryStorage } from 'arocapi/storage/directory';

// Reads File.meta.storagePath and Entity.meta.storagePath, relative to the root
export const storage = DirectoryStorage({ root: process.env.STORAGE_ROOT ?? '/srv/archive' });
