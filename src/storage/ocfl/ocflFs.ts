// Workarounds for @ocfl/ocfl-fs gaps, to delete under https://github.com/crate-works/arocapi/issues/117
// @ts-expect-error @ocfl/ocfl-fs ships no types, so the little used here is typed below
import ocfl from '@ocfl/ocfl-fs';

type InventoryFile = { digest: string; contentPath: string };

type OcflFs = {
  object: (config: { root: string }) => {
    getInventory: () => Promise<{ getFile: (logicalPath: string) => InventoryFile | undefined } | undefined>;
  };
  storageLayout: (config: string | object) => { map: (id: string) => string };
};

const { object, storageLayout } = ocfl as OcflFs;

/**
 * Map ids with a storage layout extension and its config
 * `loadStorage` would replace a layout it was given, and fails on an unknown one without a distinct error, so the
 * caller reads ocfl_layout.json itself
 */
export const layoutObjectRoot = (extension: string, config: object | null) => {
  const layout = storageLayout(config ? { ...config, extensionName: extension } : extension);

  return (id: string) => layout.map(id);
};

/**
 * Find a logical path in the head version of the object at `root`, or `null` when there is no object or no such path
 * Throws when the inventory is damaged
 */
export const headFile = async (root: string, logicalPath: string) => {
  const inventory = await object({ root }).getInventory();

  return inventory?.getFile(logicalPath) ?? null;
};
