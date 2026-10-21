// Workarounds for @ocfl/ocfl-fs gaps, each removable once upstream ships types, keeps a given layout and reports an
// unknown one distinctly in loadStorage, maps hashed ids without loadStorage, and encapsulates 0003 ids per spec
import { dirname, join } from 'node:path';
// @ts-expect-error @ocfl/ocfl-fs ships no types, so the little used here is typed below
import ocfl from '@ocfl/ocfl-fs';

type InventoryFile = { digest: string; contentPath: string };

type OcflFs = {
  object: (config: { root: string }) => {
    getInventory: () => Promise<{ getFile: (logicalPath: string) => InventoryFile | undefined } | undefined>;
  };
  loadStorage: (config: { root: string }) => Promise<unknown>;
  storageLayout: (config: string | object) => { map: (id: string) => string; get: (param: string) => unknown };
};

const { loadStorage, object, storageLayout } = ocfl as OcflFs;

const HASH_AND_ID = '0003-hash-and-id-n-tuple-storage-layout';

/** Every UTF-8 byte outside A-Z a-z 0-9 - _ as lowercase %xx, past 100 characters truncated and suffixed with the digest */
const encapsulate = (id: string, digest: string) => {
  const encoded = Array.from(new TextEncoder().encode(id), (byte) => {
    const char = String.fromCharCode(byte);

    return /[A-Za-z0-9_-]/.test(char) ? char : `%${byte.toString(16).padStart(2, '0')}`;
  }).join('');

  return encoded.length > 100 ? `${encoded.slice(0, 100)}-${digest}` : encoded;
};

/**
 * Map ids with the storage layout extension and config of the storage root at `root`
 * `loadStorage` would replace a layout it was given, and fails on an unknown one without a distinct error, so the
 * caller reads ocfl_layout.json itself
 */
export const layoutObjectRoot = async (root: string, extension: string, config: object | null) => {
  const layout = storageLayout(config ? { ...config, extensionName: extension } : extension);
  const digestAlgorithm = layout.get('digestAlgorithm');
  if (digestAlgorithm) {
    // Hashed layouts map only after OcflDigest.initSync, which nothing exported calls but loadStorage
    await loadStorage({ root });
  }
  if (extension !== HASH_AND_ID) {
    return (id: string) => layout.map(id);
  }

  // @ocfl/ocfl-fs lowercases the whole encapsulation directory, leaves !'()*~ unencoded and never truncates it
  const digest = storageLayout({
    extensionName: '0004-hashed-n-tuple-storage-layout',
    digestAlgorithm,
    tupleSize: 0,
    numberOfTuples: 0,
  });

  return (id: string) => join(dirname(layout.map(id)), encapsulate(id, digest.map(id)));
};

/**
 * Find a logical path in the head version of the object at `root`, or `null` when there is no object or no such path
 * Throws when the inventory is damaged
 */
export const headFile = async (root: string, logicalPath: string) => {
  const inventory = await object({ root }).getInventory();

  return inventory?.getFile(logicalPath) ?? null;
};
