import type { MetadataSource } from 'arocapi';

const storageRoot = process.env.STORAGE_ROOT ?? '/srv/archive';

type Crate = { '@graph': Array<Record<string, unknown>> };

// Your storage's helper
declare function readCrate(path: string): Promise<Crate>;

type EntityMeta = { storagePath: string };

// Read the crate and redact it; arocapi serialises the value and sets its length and ETag
export const metadata: MetadataSource = async (entity) => {
  const crate = await readCrate(`${storageRoot}/${(entity.meta as EntityMeta).storagePath}`);
  const graph = crate['@graph'].map(({ email: _email, ...node }) => node);

  return { type: 'json', value: { ...crate, '@graph': graph } };
};
