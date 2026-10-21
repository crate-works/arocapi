import { EntityMetaMetadata } from 'arocapi/storage/entity-meta';

// Metadata from the JSON object at Entity.meta.rocrate
export const metadata = EntityMetaMetadata();

// Or from another key, such as Entity.meta.crate
export const fromCrate = EntityMetaMetadata({ key: 'crate' });
