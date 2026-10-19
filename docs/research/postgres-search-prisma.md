# Research: Postgres search through Prisma

Question (issue #77, map #71): how well can a Postgres search backend be built through Prisma, and what are the
constraints? Researched October 2026 against Prisma 7.x (arocapi's dev dependency is `prisma@^7.10.0`, peer
`@prisma/client >=6`), current PostgreSQL docs and PostGIS docs.

## Answer in brief

- Prisma Client cannot do indexed, ranked, faceted full-text search on Postgres. Its `search` filter is still a
  Preview feature (`fullTextSearchPostgres`) and does not use indexes. Everything search-shaped goes through
  `$queryRaw` with `Prisma.sql` composition; TypedSQL suits only fixed-shape queries.
- Prisma Migrate can declare a `tsvector` column as `Unsupported("tsvector")` with `@@index(..., type: Gin)`. It
  cannot declare generated columns or expression indexes without fighting migration drift. The safe shape is a
  **plain** (not generated) `tsvector` column that arocapi fills itself when it indexes an entity.
- That column can't go on the shared `Entity` model: consumers link `prisma/models` into a MySQL or Postgres schema,
  and `tsvector` would break MySQL. It needs a separate, Postgres-only model file (for example a 1:1 `EntitySearch`
  table) that Postgres consumers link as well.
- The current Prisma `entityVisibilityFilter` (a Prisma `where`) can't be spliced into raw SQL. Search totals and facets
  need visibility applied inside the SQL, so the database backend's `searchVisibilityFilter` has to be a `Prisma.Sql`
  fragment, much as the OpenSearch backend's is an OpenSearch query.
- Geo works without PostGIS. Use a core `point` column with a GiST index for the bounding box, or lat/lon b-tree
  columns, plus a stored geohash string grouped with `left(geohash, p)`. PostGIS adds `ST_GeoHash`, `&&` on
  geometry and `ST_SquareGrid`, but it's an extra dependency the reference backend doesn't need.
- arocapi's existing models (`VarChar(768)`, `Text`, `Json`, `BigInt`, indexes) are valid on Postgres unchanged.
  Two things change in behaviour: collation, and `Json` becoming `jsonb`.

## 1. `tsvector` column and GIN index in Prisma models

**Prisma FTS status.** Prisma's `search` filter on Postgres is behind the `fullTextSearchPostgres` preview flag. In
v6, full-text search went GA for MySQL only: "In Prisma v6, FTS has been promoted to General Availability on MySQL. It
still remains in Preview for PostgreSQL" ([v6 docs][prisma-fts-v6]). The current docs still list it as preview
([current docs][prisma-fts]). The v6 page states "Prisma Client does not currently support using indexes to speed up
full text search" on PostgreSQL, and links a known slowness issue ([prisma#23627][p23627], open: "Full-text search
query is very slow with `search` API but fast with raw SQL"). Related open issues: [prisma#8950][p8950] ("Postgres
Full-Text Search Index is not used") and [prisma#10386][p10386] ("Support fulltext search using indexes in
PostgreSQL"). The operator syntax is `to_tsquery` style (`fox & dog`, `fox <-> dog`) ([v6 docs][prisma-fts-v6]).
`_relevance` ordering exists, but there is no rank weighting, no headline and no aggregation. **Conclusion:** don't
use it.

**Declaring the column.** `Unsupported("…")` fields are created by `migrate dev` / `db push`, but "the field will not
be available in the generated Prisma Client" ([unsupported features][prisma-unsupported]). Reading one in raw SQL
requires a cast: "`Unsupported` types need to be cast to Prisma Client supported types before using them in
`$queryRaw`" ([raw queries][prisma-raw]).

**GIN index.** `@@index` supports `type: Gin` (also `Gist`, `SpGist`, `Brin`, `Hash`) on PostgreSQL
([indexes][prisma-indexes]). A user in [prisma#24180][p24180] declared
`@@index([textSearch], type: Gin)` on an `Unsupported` field and Prisma emitted the index. The docs don't say
explicitly whether `@@index` accepts `Unsupported` fields; that issue is the evidence that it does.

**Expression indexes are not supported.** "Indexes using a function (such as `to_tsvector`) to determine the indexed
value are not yet supported by Prisma ORM" and they are invisible to `db pull` ([indexes][prisma-indexes]). The
`CREATE INDEX … USING GIN (to_tsvector('english', body))` form from the
[PostgreSQL docs][pg-tables] would have to live in a hand-edited migration, and Prisma would treat it as drift.

**Generated columns are not supported.** Feature request [prisma#6336][p6336] "Generated columns" is open.

- Hand-adding `tsvector GENERATED ALWAYS AS (…) STORED` plus a GIN index in a custom migration: the next
  `migrate dev` generates `DROP INDEX` / `DROP COLUMN` for them, silently if the dev DB is empty. Open:
  [prisma#24180][p24180]. A maintainer's answer: "Prisma does not support what you are trying to use in Prisma Schema
  … and hence will of course try to clean up your database".
- Putting the generated expression inside `Unsupported("tsvector GENERATED ALWAYS AS (…) STORED")` creates the column,
  but the next migration emits `ALTER COLUMN … DROP DEFAULT`, which Postgres rejects for generated columns. Open:
  [prisma#24496][p24496] "Prisma `Unsupported()` columns can be overwritten" (reported in [#24180][p24180]).
- `@default(dbgenerated())` on a generated column broke in Prisma 4.0 with the same `DROP DEFAULT`
  ([prisma#14799][p14799], closed as fixed).

**What works cleanly.** A plain `tsvector` column declared `Unsupported("tsvector")`, nullable or defaulted, with
`@@index([search], type: Gin)`, is fully representable in the schema, so it causes no drift. The backend sets it with
`$executeRaw` when it indexes an entity:
`UPDATE … SET search = setweight(to_tsvector(cfg, name), 'A') || setweight(to_tsvector(cfg, description), 'B')`.
arocapi already has an explicit indexing step (OpenSearch documents are written by the consumer/indexer), so a
generated column buys little. A trigger would also be drift-free in practice, because Prisma's schema diff doesn't
model triggers. It is still invisible to the schema, though, and the explicit update is simpler.

**Where the column lives.** Consumers symlink `node_modules/arocapi/prisma/models` into their schema folder and choose
`provider = "mysql"` or `"postgresql"` themselves (`website/src/content/docs/getting-started/database.mdx`). An
`Unsupported("tsvector")` field on `Entity` would emit `tsvector` DDL on MySQL. The Postgres backend therefore needs
its own model file, for example `prisma/models-postgres/search.prisma` holding a 1:1 table keyed by entity id with the
`tsvector`, facet and geo columns. Postgres consumers link it alongside `prisma/models`. That needs a back-relation
field on `Entity` only if the model declares a Prisma relation. To keep `Entity` untouched, skip the Prisma
`@relation` and rely on a raw `JOIN` (and optionally a raw FK in a custom migration). Note that Prisma would then see
that FK as drift.

**PostgreSQL facts behind the choice** ([PG text search tables][pg-tables], [indexes][pg-indexes]):

- Stored `tsvector` column vs expression index: the column means queries need not repeat the configuration, and
  "searches will be faster, since it will not be necessary to redo the `to_tsvector` calls to verify index matches".
  The expression index "requires less disk space".
- "GIN indexes are the preferred text search index type". GIN stores only lexemes, not weights, so queries that
  involve weights need a recheck against the table row. "GIN index build time can often be improved by increasing
  `maintenance_work_mem`", which is relevant on a Pi.

## 2. Query side: tsquery, ranking, headlines, safe composition

**Parsing user input.** `websearch_to_tsquery` "will never raise syntax errors, which makes it possible to use raw
user-supplied input for search". It handles quoted phrases, `or` and `-`. `to_tsquery` "is less forgiving" and errors
on unseparated tokens ([PG text search controls][pg-controls]). arocapi's `basic` search maps to
`websearch_to_tsquery`. Its `advanced` (OpenSearch `query_string`) mode has no equivalent. Either define a reduced
grammar or treat advanced as websearch syntax. There is also no `fuzziness: AUTO` equivalent in core FTS. Typo
tolerance would need `pg_trgm` (contrib), which is out of scope for the reference backend. Prefix matching (`term:*`)
isn't expressible in websearch syntax. To add it, build a second tsquery from sanitised tokens and combine it with the
tsquery `&&` / `||` operators.

**Field weights.** Build the vector as `setweight(to_tsvector(cfg, name), 'A') || setweight(…description…, 'B')`,
which mirrors OpenSearch's `name^2, description`. Rank with `ts_rank([weights,] vector, query [, normalization])` or
`ts_rank_cd`. The weights array is `{D, C, B, A}`, default `{0.1, 0.2, 0.4, 1.0}`. Normalization is a bit mask, and
32 scales ranks into 0–1 ([controls][pg-controls]). "Ranking can be expensive since it requires consulting the
`tsvector` of each matching document" ([controls][pg-controls]). Cost grows with the number of matches, not with the
page size.

**Headlines.** "`ts_headline` uses the original document, not a `tsvector` summary, so it can be slow", so compute it
only for the current page: an outer query over an inner `ORDER BY rank LIMIT n` subquery. Options include `StartSel`
/ `StopSel`, `MaxWords` / `MinWords` and `MaxFragments`. Its output "is not guaranteed to be safe for direct inclusion
in web pages", so sanitise it or use non-HTML delimiters ([controls][pg-controls]).

**Text search configuration.** The examples use `'english'`. PARADISEC-style catalogues are multilingual, so
`'simple'` (no stemming, no stop words) is likely the safer default. Make it configurable. This is an inference, not
from a source.

**Composition through Prisma.**

- `$queryRaw` takes only a tagged template or `Prisma.sql`, and interpolated values become prepared-statement
  parameters. `Prisma.join(list)` builds `IN (…)` lists. `Prisma.empty` drops an optional fragment. Values "cannot be
  used for identifiers such as column names … or for SQL keywords". `Prisma.raw` and `$queryRawUnsafe` are the
  injection risks ([raw queries][prisma-raw]). Dynamic filters therefore compose as an array of `Prisma.sql`
  fragments joined with `Prisma.join(fragments, ' AND ')`. Facet and sort field names must come from an allow-list
  that maps each public name to a fixed SQL fragment, never from request input.
- 64-bit integers come back as `BigInt`, so `count(*)` must be converted ([raw queries][prisma-raw]).
- **TypedSQL** (`typedSql` preview flag) needs a live database at `prisma generate --sql`. It uses `$1`-style
  parameters and supports arrays via `= ANY($1)`. It doesn't support dynamically chosen columns: "you must use
  `$queryRawUnsafe`" ([TypedSQL][prisma-typedsql]). Also, arocapi ships source, not the consumer's generated client,
  so TypedSQL output would be generated in each consumer's project against their database. **Conclusion:** use
  `$queryRaw` + `Prisma.sql`, not TypedSQL, for a library backend with variable filters.

**Visibility.** Today `entityVisibilityFilter` returns a Prisma `where`, and Prisma has no API to render a `where` to
SQL or to combine it with a raw predicate. Options:

1. The database backend's `searchVisibilityFilter` returns a `Prisma.Sql` fragment over a known table alias. This is
   symmetric with OpenSearch's `searchVisibilityFilter` being an OpenSearch query.
2. Raw SQL returns candidate ids, then a Prisma `findMany` applies visibility. This breaks exact `total` and facet
   counts, which the visibility ADR (0001) requires to exclude hidden entities.

Only option 1 meets ADR 0001.

## 3. Bounding box and geohash grid

What arocapi does now (`src/utils/queryBuilder.ts`): a `geo_bounding_box` filter on `location`, plus a `geohash_grid`
aggregation at a requested precision, bounded by the box.

**Without PostGIS**:

- *Bounding box.* Core Postgres has a `point` type. GiST `point_ops` indexes `<@ (point, box)` and supports `<->`
  ordering ([PG GiST built-in operator classes][pg-gist]). That means `WHERE location <@ box(point(w,s), point(e,n))`
  is index-assisted. `point` would also be `Unsupported("point")` in Prisma, but `@@index(type: Gist)` covers it. An
  alternative is two `Float` columns (`lat`, `lng`) with a b-tree index and `BETWEEN`, which is fully Prisma-native.
  Both treat the earth as flat. Boxes crossing the antimeridian (west > east) need to be split into two predicates
  with `OR`, as OpenSearch does internally.
- *Geohash grid.* Compute the geohash in JS at index time and store it at full precision (for example 12 chars) in a
  `VarChar(12)` column. The aggregation is
  `SELECT left(geohash, $p) AS cell, count(*) … WHERE <search + visibility + bbox> GROUP BY 1`. That is a single pass
  over the matched rows, which is fine at this scale. The cell centroid or bounds are decoded in JS, as the OpenSearch
  response is today.

**With PostGIS**: `ST_GeoHash(geometry, maxchars)` (since 1.4, needs lon/lat input) ([ST_GeoHash][postgis-geohash]),
`&&` / `ST_MakeEnvelope` on a GiST-indexed `geometry`, and `ST_SquareGrid(size, bounds)` (since 3.1) for count-per-cell
joins ([ST_SquareGrid][postgis-squaregrid]). PostGIS columns are `Unsupported("geometry(Point,4326)")`, and the
extension must be installed with `CREATE EXTENSION` in a `--create-only` custom migration
([Prisma Postgres extensions][prisma-ext]). That is one more moving part on a Pi. **Recommendation:** the reference
backend uses no PostGIS (stored geohash + point or lat/lng). PostGIS stays a possible consumer subclass.

## 4. Facets, exact totals and paging at modest scale

- Facet fields today (`inLanguage`, `mediaType`, `communicationMode`, `entityType`) mostly aren't `Entity` columns, and
  several are multi-valued. They need a home in the search table: `text[]` columns with GIN indexes, or a narrow
  `entity_facet(entity_id, field, value)` table with a b-tree on `(field, value, entity_id)`. Counts come from one CTE
  of matched ids. That is
  `WITH hits AS (SELECT id … WHERE <fts> AND <filters> AND <visibility>)`, then
  `SELECT value, count(*) … JOIN hits … GROUP BY value ORDER BY count DESC LIMIT 20` for each facet, or one
  `GROUP BY field, value` over the facet table.
- OpenSearch facet semantics (counts computed under the active filters, top 20) are reproducible. "Post-filter"
  style (counts that ignore the facet's own filter) costs one extra pass per facet.
- Exact `total`: Postgres has no cached count, and "PostgreSQL must walk through all rows to determine visibility"
  ([PG wiki: slow counting][pg-count]). Exact counting is therefore O(matches). `count(*) OVER ()` on the page query,
  or a separate `count(*)` over the same CTE, both pay that once.
- Deep paging with `OFFSET` also costs O(offset). Relevance ordering has to rank every match before `LIMIT` (see
  ranking cost above).
- **Not measured.** I found no primary source with Raspberry Pi timings. By reasoning only: at tens to hundreds of
  thousands of short documents (name + description), a GIN-backed match plus rank, count and a handful of `GROUP BY`
  facets is a few full passes over at most the matched rows. Expect tens to low hundreds of milliseconds for broad
  queries on a Pi 4/5 with the working set in RAM. Worst case is an empty or very common query, which matches
  everything. Treat this as an estimate to confirm with a spike on a Pi using a realistic catalogue (for example a
  PARADISEC dump) before committing.
- Mitigations if needed: when the query is empty, skip ranking and order by name. Cap `offset`. Run facet queries in
  parallel on separate pool connections. Raise `work_mem` modestly for the facet `GROUP BY`.

## 5. Do the current models work unchanged on Postgres?

Yes for DDL. `@db.VarChar(x)` and `@db.Text` are valid PostgreSQL native types. `Json` defaults to `jsonb`, `BigInt`
to `bigint` and `DateTime` to `timestamp(3)` ([schema reference][prisma-ref]). The plain `@@index([…])` b-tree indexes
port as-is. `prisma/migrations` in this repo is MySQL-only (`migration_lock.toml`: `provider = "mysql"`), but
consumers generate their own migrations, so that isn't a blocker. Differences to know:

- **Index entry size.** A b-tree entry "cannot exceed approximately one-third of a page" ([PG B-tree][pg-btree]),
  about 2.7 kB with 8 kB pages. `VarChar(768)` counts characters, so a 768-character id made entirely of 4-byte UTF-8
  characters could exceed it. Real URI or ARK ids are ASCII and far shorter, so this is a theoretical edge, not a
  blocker. 768 itself came from InnoDB's 3072-byte limit with utf8mb4.
- **Collation.** The MySQL migration sets `utf8mb4_unicode_ci` (case- and accent-insensitive). Postgres's default is
  deterministic and case-sensitive. That affects `GET /entities` `orderBy name` (upper and lower case sort apart) and
  any equality or `contains` filters. Prisma's `mode: 'insensitive'` filter option is available on Postgres. Ids are URIs, so
  case-sensitive matching is arguably more correct for them.
- **`meta Json` becomes `jsonb`.** Keys are reordered and duplicate keys collapse. arocapi never returns `meta`, so
  this matters only to consumers.
- **Raw SQL portability.** Postgres folds unquoted identifiers to lower case, so raw SQL must quote `"entityType"`,
  `"memberOf"` and so on. Tables are mapped to lower-case `entity` / `file`, so those need no quoting.

## Recommendation

Build the Postgres reference backend on `$queryRaw` + `Prisma.sql`, not Prisma's preview `search` API or TypedSQL.

1. Ship a separate Postgres-only Prisma model file with a 1:1 search table: plain `Unsupported("tsvector")` + GIN,
   facet columns or a facet table, `geohash VarChar(12)` and point or lat/lng. The backend populates it explicitly at
   index time. This avoids generated columns and expression indexes, which Prisma Migrate fights (#24180, #24496,
   #6336).
2. Make the backend's `searchVisibilityFilter` a `Prisma.Sql` fragment so totals and facets respect visibility in SQL.
3. Use `websearch_to_tsquery` with the `simple` config (configurable), `setweight` A/B for name/description, and
   `ts_rank_cd` with normalization 32. Use `ts_headline` only on the page.
4. Skip PostGIS: bounding box via point/GiST (or lat/lng b-tree), grid via `GROUP BY left(geohash, p)`.
5. Before committing to the design, run a spike on a Pi against a realistic catalogue to measure the
   empty-query/broad-query worst case for exact total + facets.

[prisma-fts]: https://www.prisma.io/docs/orm/prisma-client/queries/full-text-search
[prisma-fts-v6]: https://www.prisma.io/docs/orm/v6/prisma-client/queries/full-text-search
[prisma-unsupported]: https://www.prisma.io/docs/orm/prisma-schema/data-model/unsupported-database-features
[prisma-indexes]: https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes
[prisma-raw]: https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries
[prisma-typedsql]: https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/typedsql
[prisma-ext]: https://www.prisma.io/docs/orm/prisma-schema/postgresql-extensions
[prisma-ref]: https://www.prisma.io/docs/orm/reference/prisma-schema-reference
[p23627]: https://github.com/prisma/prisma/issues/23627
[p8950]: https://github.com/prisma/prisma/issues/8950
[p10386]: https://github.com/prisma/prisma/issues/10386
[p24180]: https://github.com/prisma/prisma/issues/24180
[p24496]: https://github.com/prisma/prisma/issues/24496
[p14799]: https://github.com/prisma/prisma/issues/14799
[p6336]: https://github.com/prisma/prisma/issues/6336
[pg-controls]: https://www.postgresql.org/docs/current/textsearch-controls.html
[pg-tables]: https://www.postgresql.org/docs/current/textsearch-tables.html
[pg-indexes]: https://www.postgresql.org/docs/current/textsearch-indexes.html
[pg-gist]: https://www.postgresql.org/docs/current/gist.html
[pg-btree]: https://www.postgresql.org/docs/current/btree.html
[pg-count]: https://wiki.postgresql.org/wiki/Slow_Counting
[postgis-geohash]: https://postgis.net/docs/ST_GeoHash.html
[postgis-squaregrid]: https://postgis.net/docs/ST_SquareGrid.html
