// Builds the OCFL storage roots under src/test/fixtures/ocfl with node:fs and node:crypto alone, so the fixtures
// don't depend on the library under test. Run with `pnpm fixtures:ocfl` and commit the output.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const out = join(import.meta.dirname, '../src/test/fixtures/ocfl');

/** Logical path → bytes */
type State = Record<string, string>;

type Version = { message: string; state: State };

type Damage =
  /** The sidecar records a digest that isn't the inventory's */
  | 'sidecar'
  /** inventory.json isn't JSON */
  | 'unparseable'
  /** A manifest content path leaves the object root */
  | 'escaping-manifest';

type ObjectSpec = {
  id: string;
  versions: Version[];
  /** A mutable HEAD revision (extension 0005) on top of the last version, which readers of head must ignore */
  mutableHead?: State;
  damage?: Damage;
};

type Layout = {
  extension: string;
  description: string;
  /** Written to extensions/<extension>/config.json */
  config?: Record<string, unknown>;
  map: (id: string) => string;
};

type StorageRootSpec = { dir: string; layout: Layout; objects: ObjectSpec[] };

const hash = (algorithm: string, data: string) => createHash(algorithm).update(data, 'utf8').digest('hex');
const sha512 = (data: string) => hash('sha512', data);

const write = (path: string, data: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};

/** Write a pretty inventory and its sidecar, returning the bytes */
const writeInventory = (dir: string, inventory: unknown) => {
  const text = `${JSON.stringify(inventory, null, 2)}\n`;
  write(join(dir, 'inventory.json'), text);
  write(join(dir, 'inventory.json.sha512'), `${sha512(text)}  inventory.json\n`);
};

const created = (version: number) => new Date(Date.UTC(2025, 0, version)).toISOString();

const writeObject = (root: string, { id, versions, mutableHead, damage }: ObjectSpec) => {
  write(join(root, '0=ocfl_object_1.1'), 'ocfl_object_1.1\n');

  const manifest: Record<string, string[]> = {};
  const inventoryVersions: Record<string, unknown> = {};
  let inventory: Record<string, unknown> = {};

  versions.forEach(({ message, state }, index) => {
    const name = `v${index + 1}`;
    const digests: Record<string, string[]> = {};
    for (const [logicalPath, body] of Object.entries(state)) {
      const digest = sha512(body);
      if (!manifest[digest]) {
        const contentPath = `${name}/content/${logicalPath}`;
        write(join(root, contentPath), body);
        manifest[digest] = [contentPath];
      }
      digests[digest] = [...(digests[digest] ?? []), logicalPath];
    }
    inventoryVersions[name] = {
      created: created(index + 1),
      message,
      user: { name: 'arocapi fixtures' },
      state: digests,
    };
    inventory = {
      id,
      type: 'https://ocfl.io/1.1/spec/#inventory',
      digestAlgorithm: 'sha512',
      head: name,
      contentDirectory: 'content',
      manifest: structuredClone(manifest),
      versions: structuredClone(inventoryVersions),
    };
    writeInventory(join(root, name), inventory);
  });

  if (damage === 'escaping-manifest') {
    for (const paths of Object.values(inventory.manifest as Record<string, string[]>)) {
      paths[0] = `../${paths[0]}`;
    }
  }
  writeInventory(root, inventory);

  if (damage === 'sidecar') {
    write(join(root, 'inventory.json.sha512'), `${sha512('not the inventory')}  inventory.json\n`);
  }
  if (damage === 'unparseable') {
    const text = '{ "id": "truncated",';
    write(join(root, 'inventory.json'), text);
    write(join(root, 'inventory.json.sha512'), `${sha512(text)}  inventory.json\n`);
  }

  if (mutableHead) {
    const head = join(root, 'extensions/0005-mutable-head');
    write(join(head, 'config.json'), `${JSON.stringify({ extensionName: '0005-mutable-head' }, null, 2)}\n`);
    const headManifest = structuredClone(manifest);
    const state: Record<string, string[]> = {};
    for (const [logicalPath, body] of Object.entries(mutableHead)) {
      const digest = sha512(body);
      if (!headManifest[digest]) {
        const contentPath = `extensions/0005-mutable-head/head/content/r1/${logicalPath}`;
        write(join(root, contentPath), body);
        headManifest[digest] = [contentPath];
      }
      state[digest] = [...(state[digest] ?? []), logicalPath];
    }
    const next = `v${versions.length + 1}`;
    writeInventory(join(head, 'head'), {
      ...inventory,
      head: next,
      manifest: headManifest,
      versions: {
        ...inventoryVersions,
        [next]: { created: created(versions.length + 1), message: 'Unreleased', state },
      },
    });
  }
};

const writeStorageRoot = ({ dir, layout, objects }: StorageRootSpec) => {
  const root = join(out, dir);
  rmSync(root, { recursive: true, force: true });
  write(join(root, '0=ocfl_1.1'), 'ocfl_1.1\n');
  write(
    join(root, 'ocfl_layout.json'),
    `${JSON.stringify({ extension: layout.extension, description: layout.description }, null, 2)}\n`,
  );
  if (layout.config) {
    write(join(root, 'extensions', layout.extension, 'config.json'), `${JSON.stringify(layout.config, null, 2)}\n`);
  }
  for (const object of objects) {
    writeObject(join(root, layout.map(object.id)), object);
  }
};

/** LDaCA's layout with its defaults: `https://host/a/b` → `https_host/a/b/__object__` */
const pathDirect: Layout = {
  extension: '000N-path-direct-storage-layout',
  description: 'OCFL object identifiers are used directly as the path.',
  map: (id) => {
    const url = URL.parse(id);
    const path = url ? `${url.protocol.slice(0, -1)}_${url.hostname}${url.pathname}${url.search}${url.hash}` : id;

    return `${path.replace(/^\/+|\/+$/g, '')}/__object__`;
  },
};

const flatDirect: Layout = {
  extension: '0002-flat-direct-storage-layout',
  description: 'OCFL object identifiers are used without changes as directory names under the storage root.',
  map: (id) => id,
};

type NTuple = { digestAlgorithm: string; tupleSize: number; numberOfTuples: number };

const tuples = ({ tupleSize, numberOfTuples }: NTuple, digest: string) =>
  Array.from({ length: numberOfTuples }, (_, index) => digest.slice(index * tupleSize, (index + 1) * tupleSize));

/** Every UTF-8 byte outside A-Z a-z 0-9 - _ as %xx, truncated past 100 characters with the digest appended */
const encapsulation = (id: string, digest: string) => {
  let encoded = '';
  for (const byte of Buffer.from(id, 'utf8')) {
    const safe =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x5f;
    encoded += safe ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, '0')}`;
  }

  return encoded.length > 100 ? `${encoded.slice(0, 100)}-${digest}` : encoded;
};

const hashAndIdConfig: NTuple = { digestAlgorithm: 'sha512', tupleSize: 2, numberOfTuples: 4 };
const hashAndIdNTuple: Layout = {
  extension: '0003-hash-and-id-n-tuple-storage-layout',
  description: 'OCFL object identifiers are hashed into n-tuple directories holding the percent-encoded identifier.',
  config: { extensionName: '0003-hash-and-id-n-tuple-storage-layout', ...hashAndIdConfig },
  map: (id) => {
    const digest = hash(hashAndIdConfig.digestAlgorithm, id);

    return [...tuples(hashAndIdConfig, digest), encapsulation(id, digest)].join('/');
  },
};

const hashedConfig: NTuple = { digestAlgorithm: 'md5', tupleSize: 2, numberOfTuples: 15 };
const hashedNTuple: Layout = {
  extension: '0004-hashed-n-tuple-storage-layout',
  description: 'OCFL object identifiers are hashed into n-tuple directories.',
  config: { extensionName: '0004-hashed-n-tuple-storage-layout', ...hashedConfig, shortObjectRoot: true },
  map: (id) => {
    const digest = hash(hashedConfig.digestAlgorithm, id);
    const used = hashedConfig.tupleSize * hashedConfig.numberOfTuples;

    return [...tuples(hashedConfig, digest), digest.slice(used)].join('/');
  },
};

/** A layout OcflStorage doesn't implement, so a consumer must pass `objectRoot` */
const customLayout: Layout = {
  extension: 'example-custom-layout',
  description: 'Objects sit in objects/ under the last segment of their identifier.',
  map: (id) => `objects/${id.split('/').at(-1)}`,
};

// Must match storedItems in src/test/helpers/storageBackendContract.ts
const crate = JSON.stringify({ '@context': 'https://w3id.org/ro/crate/1.2/context', '@graph': [{ name: 'Ŋaŋa' }] });
const storedItems: State = {
  'collection/ro-crate-metadata.json': crate,
  'collection/item/greeting.wav': 'RIFF greeting bytes',
  'collection/item/notes.bin': 'speaker,line\nŋaŋa,hello\n',
};

const itemCrate = JSON.stringify({ '@context': 'https://w3id.org/ro/crate/1.2/context', '@graph': [{ name: 'Item' }] });
const single = (state: State): Version[] => [{ message: 'Initial', state }];

writeStorageRoot({
  dir: 'path-direct',
  layout: pathDirect,
  objects: [
    {
      id: 'https://example.com/storage/contract',
      versions: [
        {
          message: 'Initial',
          state: {
            'collection/ro-crate-metadata.json': crate,
            'collection/item/greeting.wav': 'RIFF superseded greeting bytes',
            'collection/item/removed.wav': 'RIFF removed bytes',
          },
        },
        { message: 'Replace the greeting, add notes', state: storedItems },
      ],
      mutableHead: { ...storedItems, 'collection/item/greeting.wav': 'RIFF unreleased greeting bytes' },
    },
    { id: 'https://example.com/storage/item', versions: single({ 'ro-crate-metadata.json': itemCrate }) },
    { id: 'https://example.com/storage/bad-sidecar', versions: single(storedItems), damage: 'sidecar' },
    { id: 'https://example.com/storage/unparseable', versions: single(storedItems), damage: 'unparseable' },
    { id: 'https://example.com/storage/escaping-manifest', versions: single(storedItems), damage: 'escaping-manifest' },
  ],
});

writeStorageRoot({
  dir: 'custom-layout',
  layout: customLayout,
  objects: [{ id: 'https://example.com/storage/custom', versions: single({ 'ro-crate-metadata.json': itemCrate }) }],
});

// Must match the ids in src/storage/ocfl/ocfl.test.ts
const layoutIds = {
  'flat-direct': ['object-01', '..hor_rib:lé-$id'],
  'hash-and-id-n-tuple': ['object-01', '..Hor/rib:lè-$id', "info:fedora/Object~01!'()*", 'abcdefghij'.repeat(11)],
  'hashed-n-tuple': ['object-01', '..hor/rib:le-$id'],
};

for (const [dir, layout] of [
  ['flat-direct', flatDirect],
  ['hash-and-id-n-tuple', hashAndIdNTuple],
  ['hashed-n-tuple', hashedNTuple],
] as const) {
  writeStorageRoot({ dir, layout, objects: layoutIds[dir].map((id) => ({ id, versions: single(storedItems) })) });
}
