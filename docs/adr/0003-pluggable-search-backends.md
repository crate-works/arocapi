# 3. Search goes through a pluggable search backend

Date: 2026-10-20

## Status

Accepted, for 5.0

## Context

arocapi searched only through OpenSearch. raspbocrate runs Oni and arocapi on
a Raspberry Pi with 4–8 GB of memory, which can't sensibly run OpenSearch, so
a second search backend is needed. Postgres full-text search is fast enough
there: on a Pi 5 a full response (page, exact total and five facets) takes up
to 72 ms at 10k entities and 280 ms at 50k.

The clients are Oni (basic and advanced search, filters, facets, date ranges,
geo, configured sorts), downloader and cockatiel (basic search, exact-term
filters, facets, paging). No consumer subclasses the OpenSearch query builder.

The OpenSearch implementation also had faults that a second backend would
copy:

- Advanced queries went to `query_string`, which reaches every indexed field,
  so a request could search inside Metadata or Content it would be Denied.
- Filter and facet keys could disagree (`field` vs `field.keyword`).
- Undeclared filter keys and bad ranges weren't rejected.
- The index name was fixed.

RO-Crate API v0.4.0 gives an implementation no way to say it lacks advanced
search, geo or relevance sorting, so a lightweight backend couldn't describe
itself honestly.

## Decision

### The contract

- A search backend is a plain object satisfying the exported `SearchBackend`
  interface: `capabilities`, `search(request, context)`, `index(docs, options?)`
  and `remove(ids)`. A required `search` option takes it. The `opensearch`,
  `queryBuilderClass`, `queryBuilderOptions` and `searchVisibilityFilter`
  options and the `OpensearchQueryBuilder` and `AllVisibleSearchFilter`
  exports are removed.
- Reference backends are exported factories, `OpenSearchBackend({...})` and
  `PostgresBackend({...})`, like `LicenceAccess`. They are customised through
  options only, with no subclassing or protected hooks, so their internals can
  change without a major release. A consumer's own backend is an object
  literal typed `SearchBackend`.
- The consumer owns any client and connection; the contract has no lifecycle.

### Who does what

- arocapi validates and normalises the request, so a backend only ever
  receives valid requests. It fills in defaults, rejects undeclared filter
  keys, undeclared sorts and ranges on string or boolean filters with a 400
  `VALIDATION_ERROR`, splits filters into exact terms or ranges, converts date
  bounds to UTC instants and handles paging.
- The backend searches and returns ordered hit ids with the spec's
  `searchExtra`, an exact `total`, and spec-shaped `facets` and `geohashGrid`.
  It applies visibility itself, in its own query language, to the hits, the
  total and the facets (ADR 0001).
- arocapi then loads the Records from the database, re-applying
  `entityVisibilityFilter` and dropping any hit it can't load, decides access,
  runs the transformers and times `searchTime` around the call.
- A backend throws the exported `SearchQueryError` for a query it can't run,
  including its own engine limits; arocapi answers 422 `VALIDATION_ERROR`
  with its message. Any other error is a 500.

### Field declarations

- The reference backends take a `fields` option: a map of field name to
  `{ type, label?, …roles }`. Types are `text`, `keyword`, `date`, `number`,
  `boolean` and `geo`; roles are `basic`, `advanced`, `filter`, `facet` and
  `sort`. `facet` implies `filter`.
- Every `text` field is in basic search unless `basic: false`, with a
  `weight` of 1–4 (default 1). The other roles are opt-in, so no field is
  searchable in an advanced query unless declared. A field with no role is
  stored only for the backend's visibility filter and is never published.
- The filter, facet and sort key is always the field name. Exact forms such
  as `.keyword` are private to the backend.
- The contract's `capabilities` is shaped like `/capabilities` (`filters`,
  `facets`, `sorts`, `searchTypes`, `geo`), and arocapi validates requests
  from it alone. The exported `capabilitiesFromFields(fields)` derives it, and
  a custom backend may write it directly. Weights, facet sizes and text vs
  keyword stay out of the contract.
- `basic` search is required of every backend; `advanced` and `geo` are
  optional. At most one `geo` field is allowed, holding a single
  `{ lat, lng }`.
- A partial date is stored as its first UTC instant, and a date-time with no
  offset is UTC. A `date` facet has one bucket per UTC year, named `"YYYY"`.
  Other facet buckets are named by the value as a string and ordered by
  count, then name. Every declared facet is present in every response.
- Field names match `^[A-Za-z_][A-Za-z0-9_]*$`; `id` is reserved and
  `relevance` can't be a sort field. The factories throw on a bad declaration.

### Queries

- A basic query is a raw string each backend interprets in its own way
  (OpenSearch `multi_match`, Postgres `websearch_to_tsquery`).
- arocapi parses advanced queries into a tree and passes the tree to the
  backend; nothing is passed through raw. The grammar is the spec's
  `field: value` with `AND`/`OR` and brackets, plus quoted phrases, unary
  `NOT` and field groups (`field: (a OR b)`). Precedence is `NOT`, then `AND`,
  then `OR`, and operators are uppercase only. Wildcards, fuzzy matching,
  regexes, ranges and boosts aren't supported and are treated as ordinary
  characters.
- On a `text` field, a value matches when the field contains all its words,
  or the exact phrase if quoted; other types match exactly. Every declared
  text field is matchable on its own in every backend.
- An empty query matches every visible entity, for both search types.
- A syntax error, an undeclared field in an advanced query, or a breach of a
  fixed cap is a 422 `VALIDATION_ERROR` on `query`. The caps are constants in
  arocapi: 1024 characters for any query, and for advanced queries 10 levels
  of nesting and 64 leaf clauses, counted after field groups are expanded.
  They are documented, not published in the spec or `/capabilities`.

### The index

- Each backend owns its index. The consumer supplies one search document per
  entity: its id and values keyed by declared fields, including full text.
  arocapi never derives a search document from the entity.
- `index` upserts a batch idempotently and throws, naming the entity and key,
  on an undeclared key or a bad value. `remove` is idempotent. A rebuild is
  the consumer looping `index`. A read-only backend throws from both.
- An entity must exist before its search document is indexed. The Postgres
  backend throws an error naming the missing ids; `OpenSearchBackend` doesn't
  check.
- The Postgres backend accepts an optional Prisma transaction (`{ tx }`) so
  an entity and its search document commit together.
- `OpenSearchBackend` builds its mapping from the field declarations through
  the exported `createIndex()`, which errors on an existing index whose
  mapping differs. It takes an `indexName` option, defaulting to `entities`.
- The Postgres backend's search table, `EntitySearch`, ships in the shared
  `prisma/models` with a relation to `Entity` that cascades on delete. It
  holds weighted and per-field tsvectors behind GIN, a point behind GiST and a
  stored geohash, and needs no extensions. The backend queries it with raw
  SQL, since Prisma can't express full-text search.

### The database

- arocapi 5.0 supports Postgres 18 and later only; MySQL is dropped and
  SQLite isn't supported. Shared models may use Postgres-only features, and
  string columns are `text`.
- The integration tests run on Postgres with each reference backend, and one
  shared set of search tests holds both to the same contract.

### The spec

- arocapi 5.0 implements RO-Crate API v0.5.0, which adds required
  `search.searchTypes` (with the fields an advanced query may name),
  `search.geo` and `search.sorts` to `/capabilities`. `relevance` is always
  available and means best match first, stable for an empty query.

## Consequences

- Upgrading to 5.0 is a breaking change. Consumers replace the OpenSearch
  options with a `search` backend, declare their fields, and move from MySQL
  to Postgres. MySQL users stay on 4.x.
- Consumers write their own search documents and call `index` and `remove`
  until a deposit API calls them. Any field a visibility rule uses must be
  declared and included in the documents.
- Search results depend on both the backend's visibility filter and
  `entityVisibilityFilter`; keeping them in agreement is the consumer's job,
  and a mismatch gives a short page, not a leak.
- Customising search beyond the factory options means writing a backend.
- Every consumer carries the `EntitySearch` table; with `OpenSearchBackend`
  it stays empty.
- Relevance and basic-search matching differ between backends; the shared
  tests only hold them to the same filters, facets, sorts, totals and errors.
- Oni's advanced search loses Lucene features such as wildcards, and Oni
  should read search types, geo and sorts from `/capabilities`.
- Rebuilding an index without downtime (e.g. an OpenSearch alias swap) isn't
  supported, and can be added later without a breaking change.
- The docs' Getting started moves to Postgres.
