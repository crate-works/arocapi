# Research: reading OCFL on local disk from Node

Question (#111, map #109): what does serving an OCFL storage root on local disk from Node involve, for an arocapi reference **Storage backend**? Reads only; deposit is noted only where it constrains reads.

Sources: OCFL 1.1 spec (<https://ocfl.io/1.1/spec/>, source `OCFL/spec` `1.1/spec/index.md`), OCFL 1.1 implementation notes (<https://ocfl.io/1.1/implementation-notes/>), community extensions (<https://ocfl.github.io/extensions/>, `OCFL/extensions` `docs/`), `@ocfl/ocfl` and `@ocfl/ocfl-fs` 0.4.0 source (installed at `/home/johnf/work/ldaca/ldacapi/node_modules/.pnpm/@ocfl+ocfl@0.4.0/` and `@ocfl+ocfl-fs@0.4.0/`), <https://github.com/Language-Research-Technology/ocfl-js>, <https://github.com/Language-Research-Technology/oni-ocfl>, and the local clones `/home/johnf/work/ldaca/ldacapi` and `/home/johnf/work/paradisec/*`.

## Summary

- The only maintained Node library is LDaCA's `@ocfl/ocfl` + `@ocfl/ocfl-fs` (0.4.0, May 2026). It reads fine but is **GPL-3.0-or-later** (arocapi is ISC), pre-1.0, has one active developer, ships no TypeScript types, does no caching between requests, and doesn't implement mutable HEAD or two of the layouts it lists.
- Reading OCFL is simple enough to write in-house: about 200 lines with `node:fs` and `node:crypto` and no dependencies. Read `ocfl_layout.json` and the layout config, map the id to a path, read and verify `inventory.json`, look up logical path → digest → content path, then `fs.createReadStream` with `start`/`end`.
- The root inventory holds every version's state, so older versions need no extra reads.
- Inventory cost grows with files × versions. Cache it per object and revalidate against the small sidecar file.
- LDaCA stores one RO-Crate per OCFL object: object id = crate root `@id` (an `arcp://` URI), and `ro-crate-metadata.json` sits at the logical root. PARADISEC doesn't use OCFL.

## 1. Libraries

### `@ocfl/ocfl` and `@ocfl/ocfl-fs` (Language-Research-Technology/ocfl-js)

| | |
|---|---|
| Repo | <https://github.com/Language-Research-Technology/ocfl-js> (monorepo: `ocfl`, `ocfl-fs`, `ocfl-s3`, `ocfl-tests`) |
| Versions | 0.1.0 (2022-08) … 0.2.2 (2024-10), 0.3.0 (2025-12), 0.4.0 (2026-05-01) (`pnpm view @ocfl/ocfl-fs time`) |
| Licence | `GPL-3.0-or-later` in both `package.json`s, GitHub reports GPL-3.0 |
| Maintainers | npm: alvinsw, moisbo, ptsefton. Git contributors: only `alvinsw` (28 commits) |
| Activity | Commits Nov 2025 – May 2026 (fixity on add, typedoc, `file.stat`). 5 open issues, incl. #3 "Add an S3 backend" (open since 2023). `ocfl-s3` is in the repo but not on npm (`@ocfl/ocfl-s3` 404) |
| Node | `engines.node >= 18`. CJS with an `index.mjs` ESM wrapper |
| Types | Hand-written `lib/types.d.ts`, but no `types` field in `package.json`. ldacapi works around this with its own `src/ocfl-modules.d.ts` |
| Coupling | `@ocfl/ocfl-fs` pins `@ocfl/ocfl` to exactly `0.4.0`. Runtime deps `hash-wasm`, `js-sha512` |

Read API (`lib/storage.js`, `lib/object.js`, `lib/file.js`):

```js
import ocfl from '@ocfl/ocfl-fs';
const storage = ocfl.storage({ root, workspace });  // workspace only needed for writes
await storage.load();               // reads 0=ocfl_1.x, ocfl_layout.json, extensions/<layout>/config.json
const object = storage.object(id);  // layout.map(id) -> object root; a new instance on every call
await object.load();                // reads + sha-verifies inventory.json; resets the per-instance cache
const file = object.getFile({ logicalPath, version }); // sync; undefined if not found or not loaded
await file.text(); await file.stream({ start, end });  // web ReadableStream via fs.createReadStream
await file.stat();                  // fs.stat of the content path (size isn't in the inventory)
for await (const o of storage) {}   // walks the tree looking for 0=ocfl_object_* files
```

Notes from the source:

- `getFile` is synchronous and returns `undefined` when the inventory isn't loaded or the path is missing. ldacapi's `TODO.md` records a crash from exactly this (`Cannot read properties of undefined (reading 'text')`).
- The inventory cache (`_inventory`) lives on the `OcflObject` instance. `storage.object(id)` builds a new instance every time, and `load()` clears the cache. ldacapi's `getFile` (`/home/johnf/work/ldaca/ldacapi/src/ocfl.ts`) calls `object.load()` on every download, so every request reads, hashes and parses the inventory again.
- Every inventory read is checked against its sidecar (`_readInventory`). It throws on a mismatch, which can happen while a writer is mid-commit (see §6).
- Layouts registered in `lib/extensions/index.js`: 0002, 0003, 0004, 0006, 0007 and the local `000N-path-direct-storage-layout`. **0006 and 0007 are stubs** with no `map()`, so they throw `NotImplementedError`. **0005-mutable-head and 0008 are empty files** and are commented out. If there's no `ocfl_layout.json`, the layout is left undefined and `objectRoot()` throws. The default for `create()` is 0004.
- `validate()` is not implemented.
- `stream(options)` passes options straight to `fs.createReadStream`, so `{ start, end }` byte ranges work (relevant to #45).

### Other npm packages (not viable)

- `ocfl` 1.0.9 (UTS-eResearch, last published 2020, GPL-3.0-or-later). The ancestor of the above.
- `@coedl/ocfl` 3.9.1 (2022). Unmaintained.
- `@coedl/nocfl-js` 2.0.0 (2023): "an opinionated S3 storage library informed by ocfl but without versioning". Not OCFL.

### The licence matters

arocapi is ISC (`package.json`, `LICENSE`). If a reference backend imports a GPL-3.0-or-later module, even as an optional peer dependency on a subpath export, anyone who distributes an app using that subpath takes on GPL obligations. The map's packaging pattern (optional peer dependencies, as for `@opensearch-project/opensearch`) doesn't remove that. I'm not giving a legal opinion, but this is a reason to prefer an in-house reader (§7) or to ask LDaCA about relicensing.

## 2. Object id → object root

- The storage root holds `0=ocfl_1.1` and **may** hold `ocfl_layout.json` with `extension` and `description` keys. `extension` MUST be a *registered* extension name (spec §4.1, E070/E071). Layout parameters live in `extensions/<name>/config.json`.
- The mapping MUST be deterministic and unique (E083). Intermediate directories hold no files (E084), hierarchies end at object roots (E085), and a root SHOULD use only one layout (W014). Objects can't be nested (`_validateObjectPath` in ocfl-js enforces this).
- `ocfl_layout.json` is optional. Without it the only portable approach is to walk the tree for `0=ocfl_object_1.x` files and read each inventory's `id`, which is what `storage[Symbol.asyncIterator]` does. A backend should require a known layout, or accept a consumer-supplied mapping function.

Registered layouts (OCFL/extensions `docs/`):

| Extension | Path for id | Notes |
|---|---|---|
| 0002 flat-direct | `<id>` | id used as-is. Fails on `/`, `extensions`, > 255 chars |
| 0003 hash-and-id-n-tuple | `<h0..h2>/<h3..h5>/<h6..h8>/<percent-encoded id>` | hashed and still readable |
| 0004 hashed-n-tuple | `<h0..h2>/<h3..h5>/<h6..h8>/<full digest>` | defaults: sha256, tupleSize 3, numberOfTuples 3, `shortObjectRoot` false. The ocfl-js default |
| 0006 / 0007 | flat / n-tuple, omitting an id prefix | ocfl-js stubs |
| 0010, 0011 (direct-clean-path), 0012 | | not in ocfl-js |

**LDaCA uses neither.** `oni-ocfl` (`lib/collector.js`), ldacapi (`src/ocfl.ts`) and ldacapi's `storage/ocfl/ocfl_layout.json` all use `000N-path-direct-storage-layout`. This is a local extension that exists only in ocfl-js (`lib/extensions/000N-path-direct-storage-layout.js`). It parses the id as a URL and joins `scheme_host` with the pathname, replacing `,` with `_` in the host, then appends the suffix `/__object__`. So `arcp://name,bundled` → `arcp_name_bundled/__object__/`. It isn't registered, so `ocfl_layout.json` breaks E071 strictly, and other OCFL tools (ocfl-java, rocfl, validators) won't recognise it. arocapi's backend must implement 000N to read LDaCA's real repositories.

## 3. Logical path → content path

The spec's model (§3.5): `versions[vN].state` maps **digest → [logical paths]**, and `manifest` maps **digest → [content paths]** (relative to the object root).

To resolve `(logicalPath, version = head)`:

1. Read `<objectRoot>/inventory.json` and verify it against `inventory.json.<digestAlgorithm>` (format `<hex> inventory.json`, E061).
2. Find the digest whose `versions[version].state` array contains `logicalPath`. Build a reverse index once per cached inventory: state is keyed by digest, so a direct lookup is O(n).
3. Read `manifest[digest][0]` → content path. Absolute path = `objectRoot/contentPath`.

Points that matter for a reader:

- **Older versions need no extra reads.** The root inventory MUST be identical to the newest version's inventory (E064), and it holds every version's `state`. `vN/inventory.json` files are only redundant copies. ocfl-js resolves `getFile({ logicalPath, version: 'v1' })` from the root inventory.
- **Don't build content paths from logical paths.** With forward-delta and deduplication, an unchanged file in v3 still points at `v1/content/...`. The spec (§5.3) lets content paths differ entirely from logical paths.
- `contentDirectory` (default `content`) and `digestAlgorithm` (`sha512` or `sha256`) are per object.
- Logical and content paths are `/`-separated, with no leading or trailing `/` and no `.`/`..` segments (E051–E053, E098–E100). A reader should still check that the resolved path stays inside the object root, because it reads untrusted JSON.
- RO-Crate `@id`s for files are URI references (`my%20file.wav`), but OCFL logical paths are plain strings (`my file.wav`). The backend has to decode `@id` into a logical path. ldacapi's `getFile` gets the crate id by removing `/<storagePath>` from the end of the entity id.
- The inventory has no file size (only optional `fixity`). Size and `Content-Length` need an `fs.stat` of the content path.

## 4. Inventory read cost and caching

The inventory is one JSON file whose size grows with *files × versions*: every version's `state` lists every logical path again. ldacapi's 7-file test object has a 3.2 KB inventory. A synthetic benchmark of hashing the inventory with sha512 and parsing it (Node 24.21, `node:crypto`; `/tmp/ocflbench/b.ts`, not committed):

| files × versions | inventory size | sha512 + `JSON.parse` |
|---|---|---|
| 100 × 1 | 0.04 MB | 0.4 ms |
| 10,000 × 1 | 3.7 MB | 13 ms |
| 10,000 × 5 | 11 MB | 36 ms |
| 100,000 × 3 | 74 MB | 290 ms |

ocfl-js hashes with `hash-wasm` instead of `node:crypto`, so its numbers will be a bit higher. Most LDaCA and PARADISEC objects are small, but corpora with thousands of files exist, and the cost is paid on every `/file` and `/entity/:id/metadata` request unless cached.

Caching approach:

- Cache the parsed inventory, plus a logical-path → content-path index per version, keyed by object id. Use an LRU bounded by count or by approximate bytes.
- Revalidate cheaply: the sidecar `inventory.json.<alg>` is about 150 bytes and changes whenever the inventory changes. Comparing its contents, or the `mtime`/`ino` from `fs.stat`, to the cached value catches new versions without re-reading the inventory. A short TTL (seconds) can save even that stat.
- Read-only clients can briefly see an invalid object while a writer swaps the root inventory. The implementation notes (§3.7.1) expect "upstream caching" to cover this, so a backend should serve the last good cached inventory when re-reading fails with a digest mismatch.
- Verifying the sidecar on every read is optional for a server. It costs one hash over the inventory, and only on cache misses.

## 5. Mutable HEAD (extension 0005)

<https://ocfl.github.io/extensions/0005-mutable-head.html>. An object may hold an uncommitted, in-place-mutable version `N+1` at `extensions/0005-mutable-head/head/` with its own `inventory.json`. Its manifest uses paths like `extensions/0005-mutable-head/head/content/r1/...`. Clients that implement the extension MUST load that inventory instead of the root inventory when it exists. Clients that don't implement it "CANNOT interact with content in the mutable HEAD" and just see version N. No new root versions may be created while a mutable HEAD exists.

- ocfl-js doesn't implement it (empty `0005-mutable-head.js`). oni-ocfl and ldacapi don't use it, and the local LDaCA root has no `extensions/` directories inside objects.
- For a public read API, ignoring the mutable HEAD and serving the last committed version is the safe default. A backend could detect `extensions/0005-mutable-head/head/inventory.json` and optionally serve it. The extension's warning that changes should stay in the mutable HEAD "for as short of time as possible" suggests not exposing it by default.

## 6. RO-Crate-in-OCFL conventions

**LDaCA** (oni-ocfl `lib/collector.js`, ldacapi `src/ocfl.ts`, `scripts/seed.ts`, `test-data/`):

- One RO-Crate = one OCFL object. **OCFL object id = the crate root dataset `@id`**, an ARCP URI such as `arcp://name,<corpus>/<path>` (minted by oni-ocfl `generateArcpId`).
- The crate root is the logical root: `ro-crate-metadata.json` (and `ro-crate-preview.html`) sit at logical path `ro-crate-metadata.json`, and data files at their crate-relative paths. oni-ocfl writes the metadata with `t.write('ro-crate-metadata.json', …)` inside `object.update()`, so every new version gets a fresh `vN/content/ro-crate-metadata.json` while unchanged data files keep their old content paths.
- Collections are modelled two ways. **Bundled**: a collection and its `RepositoryObject` members in one crate, one OCFL object. **Distributed**: each collection or object is its own OCFL object, linked by `pcdm:memberOf` / `pcdm:hasMember` to other objects' ARCP ids (`test-data/distributed_*`). A file entity in a bundled crate has an id like `<crateId>/<path>`, so the backend needs the crate (OCFL object) id *and* the logical path for every file, not just the entity id. In arocapi terms that pair would most naturally live in `Entity.meta`/`File.meta`, or be derived from `memberOf`/`rootCollection` (the open "who decides where things live" ticket).
- Layout: `000N-path-direct-storage-layout` (§2). Fixity: ldacapi adds `crc32` (`fixityAlgorithms: ['crc32']`).

**PARADISEC**: no OCFL in the local clones. Nabu generates RO-Crate metadata from its database (`nabu/app/views/api/v1/oni/object_meta_*.json.jb`). Nyingarn stores crates on S3 with `@coedl/nocfl-js` (`nyingarn/api/src/common/getS3Handle.js`; `nocfl.inventory.json`), which isn't OCFL. The RO-Crate API spec's deposit notes only say implementations "are free to keep full histories internally (for example in OCFL)" (`/home/johnf/work/paradisec/ro-crate-api/docs/deposit/updating.md`).

## 7. Building an in-house reader

Steps, all with `node:fs/promises` and `node:crypto`:

1. On startup: check for `0=ocfl_1.0` or `0=ocfl_1.1`, read `ocfl_layout.json` and `extensions/<name>/config.json`, and pick a mapper. Support 0002, 0003, 0004 and 000N (needed for LDaCA). Accept a consumer `objectRoot(id)` override.
2. Per request: map id → object root → cached inventory (§4) → content path (§3) → `stat` + `createReadStream({ start, end })`.
3. Errors: no inventory → object not found. Logical path not in the version's state → file not found. Bad sidecar or invalid JSON → storage error. How these map to responses is the map's open "storage errors" item.

This avoids the GPL dependency, the missing types and the per-request inventory reload. It does mean writing a 000N mapper that matches ocfl-js exactly, including its URL parsing and `__object__` suffix. A shared contract test against an ocfl-js-built fixture would catch any drift.

## 8. Constraints on a later deposit API (not a design)

- **Writers swap the root inventory in place.** ocfl-js `_commit` (`lib/transaction.js`) moves the workspace version into `vN/`, then copies `vN/inventory.json` to `inventory.json.tmp` and renames it, *concurrently* with copying the sidecar (`Promise.all`). Readers can briefly see a new inventory with an old sidecar. A reader cache must tolerate this (§4), and must revalidate, because objects do change underneath it.
- **No locking.** Neither the spec ("does not specify … update and file locking mechanisms", implementation notes §3.7) nor ocfl-js provides it. One writer per object must be enforced upstream, e.g. in the deposit API.
- **The workspace must be on the same filesystem** for the atomic `rename` the implementation notes assume. ocfl-js forbids a workspace inside the storage root unless it's under `extensions/` (`OcflStorageImpl` constructor). So a read-only backend can take `root` alone, but a deposit API would need a `workspace` option.
- **Versions are immutable and append-only** (§3.7.1). "Current" is always `head`, so a deposit adds a version and never edits one. Readers that pin `head` per request stay consistent.
- **The id → path layout is fixed per storage root**, and the id must be known before writing. With 000N, ids that end in `/__object__` or map to paths nested under another object are rejected.
- **Mutable HEAD forbids new root versions while active.** If a deposit API ever stages changes with 0005, the read backend has to choose between seeing the staged or the committed state (§5).
- **Writing `ro-crate-metadata.json` adds a version.** Metadata-only edits still create a new object version. They're cheap on disk (forward delta), but every one makes the inventory larger (§4).
