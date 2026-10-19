# Which search features consumers actually use

Research for crate-works/arocapi#78 (map: #71). Sets the scope of a minimal OpenSearch reference backend and the floor for a Postgres one.

Researched 2026-10-20 against these local checkouts (read-only):

| Source | Path | Commit | arocapi version |
| --- | --- | --- | --- |
| arocapi | this repo | `596f272` | (current `main`, 5.0.0-beta.5+) |
| Oni UI | `~/work/paradisec/oni` | `9f35641` | n/a (client) |
| raspbocrate | `~/work/paradisec/raspbocrate` | `f5ed003` | `^4.0.1` (installed 4.0.1) |
| ldacapi | `~/work/ldaca/ldacapi` (not `~/work/paradisec/ldaca`, which does not exist) | `4f915da` | `5.0.0-beta.2` |

Plus two live, read-only probes of LDaCA dev: `https://dev.ldaca.edu.au/configuration.json` (its Oni config) and `POST https://dev.ldaca.edu.au/api/search` / `GET /api/capabilities`.

nabu (`~/work/paradisec/nabu`) is a separate Ruby implementation of the same API (`app/controllers/api/v1/oni_controller.rb`, `lib/oni/search_capabilities.rb`), not an arocapi consumer, so it is out of scope. It is where Oni's range filters and `searchExtra.segments` come from.

## What arocapi offers today

`POST /search` (`src/routes/search.ts`):

- Request: `searchType` basic|advanced, `query`, `filters` (`Record<string, string[]>`, terms only), `boundingBox`, `geohashPrecision`, `limit`/`offset`, `sort` (enum `id|name|createdAt|updatedAt|relevance`), `order` (`search.ts:26-36`).
- Index name hard-coded to `entities` (`search.ts:75`).
- Highlight hard-coded to `name` and `description` (`search.ts:84-89`).
- Response: `total`, `searchTime`, `entities[]` with `searchExtra.{score,highlight}`, `facets` (every terms-shaped aggregation bucket list), `geohashGrid` (`search.ts:143-189`).

`OpensearchQueryBuilder` (`src/utils/queryBuilder.ts`):

- basic: `multi_match` over `name^2, description`, fuzziness AUTO, empty query matches all (`:54-63`).
- advanced: `query_string` over the same fields, `default_operator: AND` (`:64-72`).
- filters: one `terms` clause per key, key used verbatim as the field (`:74-82`).
- geo: `geo_bounding_box` on hard-coded `location`; `geohash_grid` agg on `location` only when both precision and bbox are sent (`:84-99`, `:109-133`).
- default aggs: `inLanguage`, `mediaType`, `communicationMode`, `entityType` as `terms` on `<name>.keyword`, size 20 (`:40-47`). `queryBuilderOptions.aggregations` replaces them.
- `searchCapabilities()` advertises every terms agg as a `string` filter and a facet (`:135-144`), served at `GET /capabilities` (`src/routes/capabilities.ts`).
- sort: `name` → `name.keyword`; anything else is used verbatim as the field (`:146-156`).

## Oni UI (the only client)

What it sends:

- `searchType`: `basic` for the search box, `advanced` when the advanced builder is on (`src/composables/search.ts:258-259`). Advanced builds a Lucene `query_string` itself: `( name : x OR description : x OR inLanguage : x OR text : x ) AND ( field: (y) )`, with field names taken from the site config's `ui.searchFields` (`search.ts:60-87`, `:245-254`). So "advanced" means "OpenSearch `query_string` syntax with arbitrary field names".
- `filters`: from facet clicks and URL `f=` (`search.ts:107`, `:157-166`, `:260`). Terms for normal facets; for fields declared `type: date` in capabilities (or configured as `date_histogram`), each selected year goes out as `{gte: "YYYY-01-01", lte: "YYYY-12-31"}`, an array OR-ed together (`src/capabilities.ts:8-15`, `:45-69`). Before sending, filter keys not declared in `GET /capabilities` are stripped; if capabilities failed, nothing is stripped (`src/capabilities.ts:114-131`, `src/stores/capabilities.ts:139-159`, `src/services/api.ts:232-240`).
- `DownloadsModal` does an empty-query search filtered on `{"@id": [id], isOCFL: ["true"]}` (`src/components/DownloadsModal.vue:39-52`). Only shown when `features.hasZipDownload` (`src/views/CollectionView.vue:187-198`).
- Geo: map view sends `boundingBox` + `geohashPrecision` (zoom/2, clamped 1-7); clicking a cell re-searches with that cell's bbox and no precision (`search.ts:227-238`, `:267-270`; `src/views/SearchMapView.vue:268-288`). Whole map disabled by `features.disableMaps` (`src/router/index.ts:42`, `src/components/SearchLayout.vue:200`).
- `sort`/`order`: whatever the site config lists in `ui.search.sorting`, default `relevance` (`search.ts:125-133`, `:263-264`). Not constrained to arocapi's enum.
- `limit`/`offset`: page size and page (`search.ts:261-262`).

What it reads back:

- `total`, `entities` (`search.ts:282-287`).
- `facets` → facet panel, filtered and ordered by config/capabilities; for `date_histogram` facets bucket `name`s are parsed as epoch-ms timestamps and rolled up into decades (`search.ts:294-296`, `:314-414`).
- `geohashGrid` → map cells, decoded with a geohash library (`SearchMapView.vue:194-198`).
- `searchExtra.highlight` → rendered as snippets (`src/components/EntitySummary.vue:131-133`); `searchExtra.segments` (nabu only, gated by the `segments` extension) → deep links (`EntitySummary.vue:22`, `src/segments.ts`).
- Not read: `searchExtra.score` and `searchTime` are typed (`src/services/api.ts:77`, `:103`) but no view uses them.

`GET /capabilities`: yes, fetched once at startup (`src/stores/capabilities.ts:95-131`). It drives which facets render, which filters get range encoding, and which filter keys are stripped. A missing endpoint degrades to config-driven facets and unstripped filters.

## raspbocrate

- Uses stock arocapi 4.0.1, no `queryBuilderClass`, no `queryBuilderOptions` (`packages/raspbocapi/app.ts:73-192`). So default aggs, default query, no `/capabilities` (added after 4.0.1).
- Indexes into `entities` (`packages/raspbocrate/src/server/indexing.ts:3`) with explicit mappings: almost every field `text` + `.keyword` subfield, including `id`; `originatedOn` is `date`; no `location`, no `createdAt`/`updatedAt` (`indexing.ts:22-44`). Docs are one flat object per entity (`indexing.ts:5-20`, written by `src/server/import.ts:285`, `:441`).
- Ships Oni with `docker/oni-ui.json`:
  - facets `collector_name`, `rootCollection`, `countries`, `originatedOn` (`date_histogram`), `access_condition_name`, `type`, `inLanguage`, `communicationMode`, `mediaType`, `entityType` (`:203-253`).
  - sorting `relevance` and `id` (labelled "Date") (`:46-55`).
  - `searchFields` `name, description, inLanguage, countries, text` (`:254-260`).
  - maps disabled (`:261-263`).
- Consequences with the code as it stands:
  - Only the four default aggs come back, so six of the ten configured facets never render.
  - Facet filters send `inLanguage: ["English"]` etc. as `terms` on the analysed `text` field, not `.keyword`, so they will not match capitalised values.
  - Sorting by `id` hits a `text` field. OpenSearch rejects that with a 400, which arocapi turns into a 422.
  - Selecting a year on the date facet would send range objects, which arocapi's zod schema rejects. In practice the facet never renders because no `originatedOn` agg is returned.

## ldacapi

- Uses stock `OpensearchQueryBuilder` (no `queryBuilderClass`) with `queryBuilderOptions.aggregations` = `{'@type': terms on '@type', inLanguage: terms on 'inLanguage'}` (`src/index.ts:26`, `src/configuration.ts:92-96`). Both fields are mapped `keyword`, so filters work.
- Index name is configurable via `ENTITY_INDEX` (default `entities`, `entities_test` under test) (`src/configuration.ts:117`, `:166`), but arocapi always queries `entities` (`search.ts:75`). It works only because the default matches.
- Mappings (`src/configuration.ts:46-91`):
  - `id`, `entityType`, `@type`, `inLanguage`, `memberOf`, `rootCollection`, license ids: `keyword`.
  - `name`: text + `.keyword`. `description`: text.
  - `location`: `geo_shape` (WKT points/collections built in `src/indexer/search.ts:309-317`).
  - `datePublished`, `dateCreated`, `temporalCoverage`: `date_range`.
  - `_text`: file full text, filled for deferred entities (`src/indexer/search.ts:56`).
  - `dynamic: true`.
- Indexes every crate entity (files included) as its own doc with `id` = derived unique id matching the Prisma `Entity.id` (`src/indexer/search.ts:151-182`, `:262-276`; `src/indexer/indexer.ts:44-53`).
- Not used by default search: `_text` (full text is indexed but basic/advanced only search `name`/`description`, unless an advanced query names the field explicitly), the date ranges, and `geo_shape` beyond bbox/geohash.
- Live LDaCA dev (`dev.ldaca.edu.au`) runs an older arocapi: `GET /api/capabilities` → 404. `POST /api/search` returns `facets` `@type` and `inLanguage` and `searchExtra` per entity. Its Oni config lists ten facets (`root`, `entityType`, `memberOf`, `license`, `@type`, `inLanguage`, `communicationMode`, `linguisticGenre`, `encodingFormat`, `annotationType`), sorting `relevance|id|name|created_at`, `searchFields` `name, description, inLanguage, text`, map enabled. Only `@type`/`inLanguage` facets are actually served, and `created_at` is not a valid arocapi sort, so it gets a 400.

## Feature × consumer

| Feature | Oni sends/reads | raspbocrate | ldacapi | Verdict |
| --- | --- | --- | --- | --- |
| basic text query (`name`, `description`) | yes (default) | yes | yes | **floor** |
| empty query = match all | yes (browse, downloads) | yes | yes | **floor** |
| `limit`/`offset`, `total` | yes | yes | yes | **floor** |
| sort `relevance` | yes (default everywhere) | yes | yes | **floor** |
| sort `name` | configurable | not configured | configured | **floor** (cheap) |
| sort `id` | configurable | configured (broken: text field) | configured | keep, needs keyword/plain column |
| sort `createdAt`/`updatedAt` | configurable | not indexed | not indexed (config uses `created_at`) | unused; can drop or derive from DB |
| term filters | yes | yes (broken on text fields) | yes (`@type`, `inLanguage`) | **floor** |
| term facets (counts) | yes | 4 defaults | 2 custom | **floor** |
| facets declared via `/capabilities` | yes | n/a (4.0.1) | yes | **floor** |
| date range filters / date histogram facet | yes (spec 0.2.0+) | configured, never worked | date_range fields mapped, no agg | not used through arocapi today; design for it, don't require it |
| `searchType: advanced` (Lucene `query_string`, arbitrary fields) | yes | yes | yes | OpenSearch-specific; Postgres can't match it, so make it optional/capability-gated |
| highlight `name`/`description` | read and rendered | yes | yes | OpenSearch yes; Postgres optional (`ts_headline` can approximate) |
| `searchExtra.score` | not read | — | — | optional |
| `searchTime` | not read | — | — | optional |
| `boundingBox` filter | yes (map) | maps disabled, no `location` | `geo_shape` `location` | OpenSearch yes; Postgres optional (PostGIS) |
| `geohashPrecision` → `geohashGrid` | yes (map) | — | yes | same as bbox |
| full text of files (`_text`) | via advanced `text:` field only | no | indexed | not in default search; candidate for later |
| `queryBuilderClass` subclass | — | no | no | no consumer subclasses; seam can change freely |
| `queryBuilderOptions.aggregations` | — | no | yes | needs an equivalent "declare facets" option |
| custom index name | — | `entities` | `ENTITY_INDEX` (ignored by arocapi) | backend should take the index name |
| `searchExtra.segments` | yes (gated by extension) | — | — | nabu only; out of scope |

## Implications

Minimal OpenSearch reference backend:

- basic `multi_match`, the `query_string` advanced mode, term filters, terms facets, the geo bbox + geohash grid, name/description highlights, sort by relevance/name/id.
- Facets/filters declared in one place and published through `/capabilities`, with the filter key separate from the indexed field. That fixes the `.keyword` mismatch raspbocrate hits.
- Index name configurable (ldacapi's `ENTITY_INDEX`).
- No consumer subclasses `OpensearchQueryBuilder`, so replacing that seam breaks nobody in this set. Only `queryBuilderOptions.aggregations` (ldacapi) needs a migration path.
- Date range filters are what Oni sends for `date` filters, but no arocapi consumer gets them today. Worth supporting in the reference backend if cheap, not required.

Postgres floor (what Oni needs to be usable):

- Text query over name/description, empty query = all, `limit`/`offset`/`total`, sort `relevance` + `name` (+ `id`).
- Term filters and term facet counts for declared fields.
- `GET /capabilities` advertising exactly those.
- Advanced (`query_string`), highlights, geo and date ranges can be absent, provided the API says so.
- Oni hides the map via config (`features.disableMaps`), not capabilities. Advanced search has no capability flag at all, so either the spec/capabilities needs a way to advertise "no advanced/geo/highlight", or Oni sites on Postgres must disable those in config.

Bugs surfaced along the way (not fixed here):

- `search.ts:75` ignores the consumer's index name.
- Filter keys map 1:1 to fields while the default aggs use `<name>.keyword`, so default facet filters don't match on text+keyword mappings.
- The `sort` enum includes `createdAt`/`updatedAt`, which neither consumer indexes. Sorting on an unmapped field is an OpenSearch 400 → 422.
- Both Oni site configs list sorts and facets that arocapi can't serve.
