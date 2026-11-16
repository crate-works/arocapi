import { OcflStorage } from 'arocapi/storage/ocfl';

// Reads ocfl_layout.json at startup; Metadata from Entity.meta.ocflObject (+ ocflPath, default
// ro-crate-metadata.json) and Content from File.meta.ocflObject + File.meta.ocflPath
export const storage = await OcflStorage({ root: '/srv/ocfl' });

// Items found without meta
export const custom = await OcflStorage({
  root: '/srv/ocfl',
  locate: {
    metadata: (entity) => ({ object: entity.id, path: 'ro-crate-metadata.json' }),
    content: (file, entity) => (entity.memberOf ? { object: entity.memberOf, path: file.filename } : null),
  },
});
