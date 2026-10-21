# 4. Metadata and Content come from a pluggable storage backend

Date: 2026-10-21

## Status

Accepted, for 5.0

## Context

arocapi delivered Metadata and Content only through two consumer functions,
`roCrateHandler` and `fileHandler`, each with separate `get` and `head`
functions returning a `redirect`, a `stream` or a `file` (a path on disk, with
an optional nginx `accelPath`), or `false` for a 404. Every consumer wrote its
own:

- ldacapi keeps Metadata in `Entity.meta.rocrate` and Content in an OCFL
  storage root on local disk, redirecting to its own signed nginx route so
  clients can seek.
- raspbocrate streams from absolute paths stored in `meta`, or from
  `Entity.meta.rocrate`.
- The example reads collection, item and file directories and generates the
  Metadata of file entities.
- nabu, not yet on arocapi, presigns S3 URLs and generates Metadata.

No consumer used the `file` result or `accelPath`, and every `roCrateHandler`
streamed. Separate `get` and `head` functions let the two disagree, as in
raspbocrate, where HEAD described compact JSON and GET sent it pretty-printed.
`meta.storagePath` meant an absolute path in one consumer and a path inside an
OCFL object in another.

So Metadata may be stored as a file (on disk, in S3 or in OCFL), kept in the
database, or generated on request, and Content is stored on disk, in S3 or in
OCFL. Entity ids are URLs with no general mapping to where their bytes live.

The only maintained OCFL library for Node, `@ocfl/ocfl-fs` 0.4.0, is
GPL-3.0, pre-1.0 and untyped, but LDaCA maintains it and can fix it upstream.
LDaCA stores one RO-Crate per OCFL object, with the root `@id` as the object
id, under a nonstandard `000N-path-direct-storage-layout`.

A deposit API may follow. It needn't be designed now, but this decision must
not preclude it.

## Decision

### The contract

- A required `storage` option takes a storage backend: a plain object of two
  halves, `{ metadata: MetadataSource; content: ContentSource }`, typed by the
  exported `StorageBackend`. `fileHandler` and `roCrateHandler` are removed.
- `metadata(entity, context)` delivers an entity's Metadata.
  `content(file, entity, context)` delivers a file's Content, where `entity`
  is the file's entity with its `meta`, so a backend can read a location
  stored at index time without a database lookup. `context` is the
  `RequestContext`; for `content` it also carries `contentDisposition`, the
  `Content-Disposition` value the library computed from `?disposition` and
  `?filename`.
- Each returns, or resolves to, a delivery or `null`. HEAD and GET make the
  same call, so they can't disagree.
- Reference backends are factories that return both halves and may share
  state between them. A consumer mixes sources by setting one half to another
  source:

  ```ts
  storage: {
    metadata: EntityMetaMetadata({ key: 'rocrate' }),
    content: (await OcflStorage({ root: '/data/ocfl' })).content,
  },
  ```

- As in ADR 0003, factories are customised through options only, the
  consumer owns every client (`prisma`, the S3 client) and passes it in, and
  the contract has no lifecycle. A backend needing more than the entity
  (e.g. its parent's `meta`) takes `prisma` in its options.

### Deliveries

- `stream`: a lazy `open()`, called only on GET, with `contentLength`,
  optional `etag` and `lastModified`, and for Content a `contentType`.
- `path`: an absolute `path` the library opens, with the same headers as
  `stream`. There is no nginx acceleration.
- `redirect`: a `url`. HEAD answers 302 too, and `noRedirect` behaves as
  before.
- `json`, for Metadata only: a `value` the library serialises once, setting
  the length and a strong ETag from those bytes. This is how generated or
  redacted Metadata is served.
- The library sends Metadata as `application/ld+json` whatever the delivery,
  so Metadata deliveries carry no `contentType`.
  It sets `Content-Disposition` on `stream` and `path` deliveries; a
  redirecting backend bakes `context.contentDisposition` into its URL.
- Storage is the source of truth for size, ETag and Last-Modified, so a
  stale `File.size` can't produce a wrong header. `File.mediaType` is the
  source of truth for Content-Type, since stored types are often
  `application/octet-stream`.

### Errors

- `null` is a 404. Anything thrown is a 500, logged. There is no storage
  error class.
- Reference backends turn their own "missing" errors (`ENOENT`, S3
  `NoSuchKey`, an object or path missing from an OCFL inventory) into `null`.

### Where things live

- The consumer decides. There is no built-in layout, since entity ids don't
  map to paths. Each stored reference backend takes a `locate` option, the
  object `{ metadata?(entity), content?(file, entity) }`, whose functions
  return, or resolve to, a Storage key or `null`.
- Without `locate`, each backend reads a default key from `meta`:

  | Backend   | Content                                       | Metadata                                                                             |
  | --------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
  | Directory | `File.meta.storagePath`                       | `Entity.meta.storagePath`                                                            |
  | S3        | `File.meta.storageKey`                        | `Entity.meta.storageKey`                                                             |
  | OCFL      | `File.meta.ocflObject` + `File.meta.ocflPath` | `Entity.meta.ocflObject` + `Entity.meta.ocflPath` (default `ro-crate-metadata.json`) |

  A Metadata key names the file holding the Metadata itself, with nothing
  appended, so several entities may share one file. A file entity without
  one gets a 404 unless the consumer mixes in another Metadata half.
- A missing `meta` value is `null` (404). A value of the wrong shape throws
  (500), logged with the entity id and key, because it is an indexing bug.
  `meta` stays Prisma's `JsonValue`; the library exports a TypeScript type
  for each shape its reference backends read and checks it at runtime.
- A key or path that is absolute or has a `..` segment throws before any
  read or presign, whether it came from `meta` or from `locate`, on every
  backend (including S3, where `..` is legal). The check guards keys, not
  the filesystem: a storage root is trusted, and `DirectoryStorage` and
  `OcflStorage` follow symlinks below it, even ones pointing outside it.

### Reference backends

- **`DirectoryStorage({ root, locate? })`** serves both halves as `path`
  deliveries below `root`, with length and Last-Modified from `stat` and a
  weak ETag from size and mtime.
- **`S3Storage({ client, bucket, locate?, delivery?, expiresIn? })`** works
  with any S3-compatible store. Content redirects to a presigned `GetObject`
  URL by default, carrying `ResponseContentType` from `File.mediaType` and
  `ResponseContentDisposition`, expiring after `expiresIn` seconds (default
  300) because the URL bypasses access. `delivery: 'stream'` proxies Content
  instead, for buckets clients can't reach or mustn't see. Metadata always
  streams. A stream calls `HeadObject` for its headers, then `open()` calls
  `GetObject` with `IfMatch`, so it never splices two versions; an object
  changed in between throws.
- **`OcflStorage({ root, objectRoot?, locate? })`** is async: it reads the
  storage root's `ocfl_layout.json` at startup and throws on a layout it
  doesn't implement unless the consumer supplies `objectRoot(id)`. It
  implements layouts 0002, 0003, 0004 and LDaCA's
  `000N-path-direct-storage-layout`. `locate` returns `{ object, path }`, the
  object id and the plain logical path. Only the head version is served;
  mutable HEAD is ignored. Each request loads the object's inventory (no
  cache), maps the logical path through head's state to a content path, and
  returns a `path` delivery with length and Last-Modified from `stat` and a
  strong ETag from the inventory digest. An inventory that fails its sidecar
  check or won't parse, or an `objectRoot` result or manifest path outside
  the root, throws.
- **`EntityMetaMetadata({ key? })`** is a Metadata half only. It returns the
  value at `Entity.meta[key]` (default `rocrate`) as a `json` delivery.

### Packaging

- Each reference backend has its own subpath: `arocapi/storage/directory`,
  `arocapi/storage/s3`, `arocapi/storage/ocfl` and
  `arocapi/storage/entity-meta`. The search backends move to
  `arocapi/search/opensearch` and `arocapi/search/postgres`, with no aliases.
  The root exports the plugin and the contract types (`StorageBackend`, the
  deliveries, the `meta` and OCFL location shapes).
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (`^3`) and
  `@ocfl/ocfl-fs` (`^0.4.0`) are optional peer dependencies, imported
  statically by their subpaths. No direct dependency is added.
- The OCFL backend reads through `@ocfl/ocfl-fs` rather than an in-house
  reader. Its gaps (types, keeping a configured layout, distinct errors) are
  worked around locally until fixed upstream, and the workarounds must be
  gone before 5.0 is stable.

### Tests

- One internal shared suite runs every reference backend through the HTTP
  app and asserts what the client receives: the bytes, HEAD headers equal to
  GET's, Content-Type, Content-Disposition, 404 for a missing item, 500 for
  an unsafe key, and a custom `locate`. S3 runs its Content half both ways,
  following presigned URLs to the server. The suite isn't exported.
- Behaviour that doesn't depend on a backend (each delivery, `null`, a
  throw, HEAD and GET sharing one call) is tested once against a fake
  backend.
- S3 tests run against VersityGW in the test containers and CI, since MinIO's
  free images have stopped and VersityGW honours
  `response-content-disposition` on presigned requests.
- The OCFL fixture is checked in, built by a committed script that uses only
  `node:fs` and `node:crypto`.

### Writes

- The contract has no writes. A deposit API would add its own key on
  `storage`, since a deposit writes an object's Metadata and Content
  together and database-kept or generated Metadata has nothing to write. It
  would choose where to write by calling the same `locate`.

## Consequences

- Upgrading is a breaking change, described in `BREAKING CHANGE:` footers
  rather than an upgrade guide: `fileHandler` becomes `storage.content`,
  `roCrateHandler` becomes `storage.metadata`, `false` becomes `null`, `head`
  and `get` merge, `accelPath` is gone, and the search subpaths move.
- Consumers on reference backends must write the default keys into `meta`
  at index time, or supply `locate`. ldacapi's indexer must write
  `ocflObject`. An old absolute `storagePath` throws rather than being
  misread.
- The default keys differ by backend, so moving from disk to S3 means
  reindexing or writing a `locate`.
- A presigned URL bypasses access until it expires, so the default window
  is short; a download need only start within it.
- An S3 stream costs two round trips per GET.
- `@ocfl/ocfl-fs` is GPL-3.0, which reaches only consumers who use the OCFL
  backend and distribute their app; the docs say so. Each OCFL request loads
  an inventory, and a request during a writer's inventory swap may get a
  500. Caching, if needed, goes upstream first.
- Serving an older OCFL version (an optional `version` on the location), an
  inventory cache, nginx acceleration, a storage error class and an exported
  contract suite can each be added later without a breaking change.
- Range requests need no contract change beyond `open` taking a range: S3
  redirects already seek, the library will serve ranges from `path`
  deliveries, and an S3 stream passes the range to `GetObject`. Until then,
  a consumer wanting seekable directory or OCFL Content writes a `content`
  half that redirects to its own signed route.
- Customising storage beyond the factory options means writing a half.
