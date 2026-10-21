# How consumers serve files and crates today

Research for [#110](https://github.com/crate-works/arocapi/issues/110), part of
[Storage: pluggable storage backends for 5.0](https://github.com/crate-works/arocapi/issues/109).

Question: how do arocapi's consumers implement `fileHandler` and `roCrateHandler`
(`src/types/fileHandlers.ts`)? For each: where Metadata and Content live, what
goes in `Entity.meta` / `File.meta`, which result type they return, how `head`
gets size and type, and what on-disk layout they rely on.

Sources were read on 2026-10-21. Local clones are cited by path and commit.

## Summary

| Consumer | arocapi | Metadata source | `Entity.meta` keys | Content source | `File.meta` keys | `fileHandler.get` result | `head` size from |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ldacapi (LDaCA) | 5.0.0-beta.2 (main), beta.5 in progress | Database: per-entity sub-crate in `Entity.meta.rocrate` | `rocrate` | OCFL on local disk | `storagePath`, `crc32` | `redirect` to its own signed `/dav` route | `File.size` (DB) |
| raspbocrate (raspbocapi) | ^4.0.1 | Disk (`<cratePath>/ro-crate-metadata.json`) or database (`Entity.meta.rocrate`) | `cratePath` or `rocrate` | Local disk, absolute path | `filePath` | `stream` | `fs.stat` |
| arocapi dev server + example seed | workspace | Disk, optionally rewritten on request | `storagePath`, `remapRootTo` | Local disk, absolute path | `storagePath` | `stream` | `File.size` (DB) + `stat` mtime |
| arocapi-ldaca (LDaCA prototype) | `file:../arocapi`, pre-1.2 | Database column `Entity.rocrate` (no handlers) | n/a | OCFL (not served) | n/a | n/a | n/a |
| nabu (PARADISEC) | none; own Rails Oni API | Generated on request (Rails views); admin copy written to S3 | n/a | S3 (`nabu-catalog-<env>`) | n/a | presigned S3 URL, 302 or `{location}` | n/a |

Findings that matter for the contract:

- **Nobody returns `type: 'file'` or `accelPath`.** Two return `stream`, one
  returns `redirect`. ldacapi does want X-Accel-Redirect and range support, but
  does both in its own `/dav` route because the `redirect` result was the only
  way to get there.
- **Every `roCrateHandler.get` returns `stream`**, either from a file on disk or
  from `JSON.stringify` of a value in `Entity.meta`. None redirects.
- **Metadata in the database is real and in use.** ldacapi keeps every entity's
  Metadata only in `Entity.meta.rocrate`. raspbocrate does too, for file entities.
  Both use the key name `rocrate`.
- **Generated Metadata is real.** The arocapi dev server rewrites the stored
  crate on each request (`remapRootTo`). nabu builds every crate on request from
  its catalogue database.
- **Locators in `meta` are inconsistent.** Absolute paths: `filePath`
  (raspbocrate), `storagePath` (arocapi example). Path relative to an OCFL
  object: `storagePath` (ldacapi). The same key, `storagePath`, means different
  things in two consumers.
- **`head` usually trusts the database** (`File.size`, `File.mediaType`) rather
  than asking storage. Only raspbocrate stats the file.
- **Content type always comes from `File.mediaType`.** No consumer sniffs it or
  asks storage for it. For Metadata it is always hard-coded `application/ld+json`.
- **Layouts in use:** OCFL with `000N-path-direct-storage-layout` (ldacapi);
  collection/item/file directories on disk (arocapi example, raspbocrate copy);
  `<collection>/<item>/<filename>` keys in S3 (nabu, paragest). The map's
  default layout matches the last two.

## ldacapi (LDaCA)

Repo: [Language-Research-Technology/ldacapi](https://github.com/Language-Research-Technology/ldacapi),
local clone `/home/johnf/work/ldaca/ldacapi` at `4f915da` (2026-10-13). `main`
pins `arocapi` `5.0.0-beta.2` (`package.json:54`). The local checkout has an
uncommitted bump to `5.0.0-beta.5` that touches `src/index.ts` but not the handlers.

### Storage

- Crates live in an OCFL 1.1 repository on local disk, via `@ocfl/ocfl-fs`, with
  root `OCFL_ROOT` (default `storage/ocfl`), a scratch workspace, `crc32` fixity
  and the `000N-path-direct-storage-layout` extension (`src/ocfl.ts` `createStorage`;
  `src/configuration.ts:111-146`). The crate's root `@id` is the OCFL object id.
- An indexer reads `ro-crate-metadata.json` from each OCFL object
  (`src/ocfl.ts` `indexObject`) and writes Entity and File rows
  (`src/indexer/structural.ts:40-100`).

### `Entity.meta`

- `{ rocrate }`: a per-entity crate built by `entityAsCrate`, which copies the
  entity into a new crate's root, adds `Dataset` to its type, and inherits
  `@context`, `conformsTo` and `license` (`src/indexer/structural.ts:56-67,116-128`).
  This is the only copy of the Metadata that arocapi serves. The OCFL
  `ro-crate-metadata.json` is not served directly.

### `File.meta`

- `{ storagePath, crc32 }` (`src/indexer/structural.ts:70-95`). `storagePath` is
  the file's logical path inside its OCFL object: the entity `@id` with the
  `<crateId>/` prefix removed. `crc32` comes from OCFL fixity, or is computed.
- `File.size` comes from the crate's `contentSize`, else the OCFL inventory, else
  `stat`. `File.mediaType` comes from `encodingFormat`
  (`src/ocfl.ts` `wrap().file`; `structural.ts:78-90`).

### `roCrateHandler`

- `get`: `JSON.stringify(entity.meta.rocrate, null, 2)` returned as
  `type: 'stream'` via `Readable.from`, `application/ld+json`, with
  `contentLength` set to the byte length (`src/index.ts:17,43-56`).
- `head`: serialises the same way to get the length (`src/index.ts:57-60`).

### `fileHandler`

- `get` returns `type: 'redirect'` to
  `${prefix}/dav/<crateId>/<storagePath>?signature=<uuid>`, passing through
  `disposition` and `filename` from the request query. The signature is a random
  UUID kept in an in-memory `Map` for 60 seconds (`src/app.ts:43-70`). `crateId`
  is worked out by removing `/<storagePath>` from the end of `file.id`.
- `head` returns `{ contentType: file.mediaType, contentLength: file.size }`
  from the database without touching storage (`src/app.ts:37-42,64`).
- ldacapi's own `GET /dav/:crateId/*` route (`src/routes/file.ts`) checks the
  signature, looks up the File row, and resolves the OCFL file with
  `repository.getFile` (`src/ocfl.ts` `getFile`, which returns
  `path = <objectRoot>/<contentPath>` plus a ranged `stream`). Then:
  - behind nginx (detected from the `Via` header) it sends `X-Accel-Redirect:
    /ocfl/<path>` and an empty 200;
  - otherwise it handles a single `Range` (206/416, `src/range.ts`) and streams
    from OCFL.
  - It also accepts `<crateId>.zip` as a download, but that is unimplemented.
- So ldacapi needs from storage: resolving a logical path to a physical path
  (for X-Accel) and ranged reads, neither of which the current `FileResult`
  lets it express together with the access check.

## raspbocrate (raspbocapi)

Repo: [crate-works/raspbocrate](https://github.com/crate-works/raspbocrate),
local clone `/home/johnf/work/paradisec/raspbocrate` at `f5ed003` (2026-06-29),
in sync with `origin/main`. It pins `arocapi` `^4.0.1`
(`packages/raspbocapi/package.json:13`) and uses the 4.x options
(`opensearch`, `accessTransformer`, `fileAccessTransformer`).

### Storage

- The admin app (`packages/raspbocrate`) imports crates from a mounted drive. It
  copies each crate from `<drivePath>/<crate.path>` to
  `<DATA_DIR>/<crate.path>` (`DATA_DIR` defaults to `./data`), dropping
  `hasPart` entries whose files are missing (`src/server/import.ts:455-488`,
  `src/server/import-jobs.ts:38-55`). The crate's directory structure on the
  drive is kept.

### `Entity.meta`

- Dataset entities (collection and items): `{ cratePath }`, the local crate
  directory. Every entity from one crate gets the same `cratePath`, so they
  all serve the whole crate's `ro-crate-metadata.json`
  (`src/server/import.ts:209-240,290-300`).
- File (MediaObject) entities: `{ rocrate }`, a small crate generated at import
  holding one `File` node plus the descriptor (`src/server/import.ts:334-376`).

### `File.meta`

- `{ filePath }`, an absolute path (`src/server/import.ts:395-403`). The path is
  `path.join(cratePath, filename)` where `cratePath` is the crate's directory **on
  the drive** (`src/server/rocrate.ts:204,267`), not the local copy. So file
  serving appears to depend on the drive still being mounted, while Metadata is
  served from the copy. This looks like a bug, not a design choice.

### `roCrateHandler` (`packages/raspbocapi/app.ts:122-195`)

- `get`: if `meta.cratePath` is set, stream
  `<cratePath>/ro-crate-metadata.json` from disk (`type: 'stream'`, size from
  `stat`). Otherwise, if `meta.rocrate` is set, stream
  `JSON.stringify(meta.rocrate, null, 2)`.
- `head`: the same branches. The database branch measures
  `JSON.stringify(meta.rocrate)` with no indentation, so `HEAD` reports a smaller
  `Content-Length` than `GET` sends (`app.ts:149` vs `app.ts:185`).
- `stat` is not wrapped in try/catch here, so a missing crate file raises an
  error instead of returning `false`.

### `fileHandler` (`packages/raspbocapi/app.ts:79-120`)

- `get`: `stat(filePath)` then `type: 'stream'` with `createReadStream`,
  `contentType: file.mediaType`, `contentLength` from `stat`. Returns `false` if
  there is no `filePath` or the file is missing.
- `head`: `stat` for the size, `file.mediaType` for the type.

## arocapi dev server and example seed

In this repo: `src/index.dev.ts` and `example/data/seed.ts`. Data is under
`example/data/<collection>/ro-crate-metadata.json` and
`example/data/<collection>/<item>/{ro-crate-metadata.json,<files>}`.
This is the layout the map proposes as the default.

### `Entity.meta`

- Collection and item: `{ storagePath }`, the absolute path of that level's
  `ro-crate-metadata.json` (`example/data/seed.ts:90-91,130-131`).
- File entity: `{ storagePath: <item crate path>, remapRootTo: <file @id> }`
  (`seed.ts:180-183`). Metadata for a file is the item's crate with
  `about` rewritten to point at the file.

### `File.meta`

- `{ storagePath }`, the absolute path of the file (`seed.ts:195-196`).
  `File.size` comes from `stat` at seed time.

### Handlers

- `roCrateHandler` (`src/index.dev.ts:80-170`): with `remapRootTo`, read and parse
  the file, rewrite the descriptor's `about.@id`, and stream the new JSON
  (generated Metadata). Otherwise stream the file. `head` repeats the rewrite
  to get the length. `lastModified` comes from the file's mtime. Returns `false`
  if the file is missing.
- `fileHandler` (`src/index.dev.ts:43-78`): `type: 'stream'` from
  `createReadStream`. `contentLength` comes from `File.size` (database), and
  `lastModified` from `stat`. `head` uses the same values.

The docs examples (`website/examples/strategies/storage-*.ts`,
`website/examples/reference/entity-meta-storage-path.ts`) show local, presigned S3
and signed-URL patterns with `meta.storagePath`. They are documentation, not
deployed consumers, so they are not counted above.

## arocapi-ldaca (LDaCA prototype)

[Language-Research-Technology/arocapi-ldaca](https://github.com/Language-Research-Technology/arocapi-ldaca),
last pushed 2025-10-08. It depends on `arocapi` as `file:../arocapi` and
registers it as `{ prisma, opensearch }` with no handlers (`index.js`). Its
schema keeps the whole crate in an `Entity.rocrate Json` column
(`prisma/schema.prisma:14-24`; `lib/addCrate.js:43-52`), and it pushes uploaded
zips into OCFL (`lib/Repository.js`, `@ocfl/ocfl-fs`). This is the pre-1.2 model:
handlers arrived in 1.2.0 (commit `cffe023`) and the `rocrate` column was removed
in 2.0.0 (`CHANGELOG.md:87-119`). ldacapi replaced it. It shows that keeping Metadata
in the database was the original LDaCA model.

## nabu (PARADISEC) and paragest

nabu (`/home/johnf/work/paradisec/nabu`, `ea9eaf50`, 2026-10-09) does not use
arocapi. It implements the Oni API in Rails (`config/routes.rb:125-137`,
`app/controllers/api/v1/oni_controller.rb`). It is the deployment that a
PARADISEC arocapi consumer would replace, so its storage model is relevant:

- **Content** lives in S3 bucket `nabu-catalog-<env>` under
  `<collection>/<item>/<filename>` (`lib/nabu/catalog.rb:39-41`). paragest, the
  ingest pipeline, writes it there (`/home/johnf/work/paradisec/paragest`
  `src/common/add-to-catalog.ts:31,108-112`), and the essence row records `size`
  and `mimetype`.
- **`GET /file/:id`** returns a 302 to a presigned `GetObject` URL valid for
  7 days, with `response-content-disposition` when `disposition=attachment`. With
  `noRedirect=true` it returns `{ location }` instead (`oni_controller.rb:217-246`;
  `catalog.rb:155-159,209-224`). Oni uses `noRedirect` when the API redirects
  (`/home/johnf/work/paradisec/oni` `src/services/api.ts:291-315`), and arocapi's
  `/file` route has the same switch (`src/routes/file.ts:127-133`).
- **Metadata** is generated on each request from the catalogue database by jb
  views (`object_meta_{collection,item,essence}.json.jb`;
  `oni_controller.rb:141-172`). A separate admin RO-Crate is also rendered and
  uploaded to `<collection>/ro-crate-metadata.json` and
  `<collection>/<item>/ro-crate-metadata.json` in the same bucket
  (`app/jobs/catalog_metadata_job.rb:15-25`; `catalog.rb:43-49,169-175`).
  The public endpoint does not read that copy.

## Older arocapi versions

- 1.0–1.1: no handlers. Metadata was stored in the `Entity.rocrate` column and
  served from there (see arocapi-ldaca above).
- 1.2.0: `fileHandler` and `roCrateHandler` introduced, with the
  `stream` / `file` (+ `accelPath`) / `redirect` results
  (`CHANGELOG.md:134-140`).
- 2.0.0: the `rocrate` column was removed, so Metadata in the database moved to a
  key inside `Entity.meta`, which is how ldacapi and raspbocrate use it.
- 3.0.0: string primary keys. `File.entityId` links each File to its Entity.
- 4.x → 5.0 beta: the handler signatures are unchanged except that the context
  type `FileHandlerContext { request, fastify }` became `RequestContext`
  (`git diff v4.0.1 HEAD -- src/types/fileHandlers.ts`). raspbocrate's handlers
  ignore the context. ldacapi reads `request.query` from it.
- No GitHub code search hits for other `arocapi` dependents beyond those above
  (`gh search code '"arocapi"' --filename package.json`; `gh search code roCrateHandler`).
