import type { MetadataSource } from 'arocapi';

type Crate = { '@graph': Array<Record<string, unknown>> };

type EntityMeta = { rocrate: Crate };

// Serve Entity.meta.rocrate without contact details; arocapi serialises the value and sets its length and ETag
export const metadata: MetadataSource = (entity) => {
  const crate = (entity.meta as EntityMeta | null)?.rocrate;
  if (!crate) {
    return null;
  }

  const graph = crate['@graph'].map(({ email: _email, ...node }) => node);

  return { type: 'json', value: { ...crate, '@graph': graph } };
};
