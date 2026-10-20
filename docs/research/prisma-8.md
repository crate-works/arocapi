# Research: what does Prisma 8 mean for arocapi 5.0?

Question (issue #91, map #71): what does Prisma 8 change, how does each change land on arocapi today and on the
planned 5.0 (Postgres 18+ only, `@prisma/adapter-pg`, a Postgres search backend over a shared `EntitySearch` model via
`$queryRaw` + `Prisma.sql`, `{ tx }` on `index`, `entityVisibilityFilter` as a Prisma `where`), and what should 5.0
pin? Researched 20 October 2026 against Prisma 7.10.1 and Prisma 8 RC (`prisma` 8.0.0-rc.23, `@prisma/orm-postgres`
8.0.0-rc.18). Claims marked **(verified)** were reproduced locally on those versions; **(inference)** marks reasoning,
not a source.

## Answer in brief

- **Prisma 8 is not a new version of the thing arocapi depends on.** It ships no `@prisma/client` and no generated
  `PrismaClient`; apps install `@prisma/orm-postgres` and query `db.orm.<namespace>.<Model>`. `@prisma/client` "stays
  at `7.10.1`, because it belongs to Prisma ORM 7 and is not part of Prisma ORM 8" ([release status][status]).
  Adopting 8 means rewriting every query arocapi makes, not raising a floor.
- **Today nothing breaks on its own.** arocapi's peer is `@prisma/client`, which has no 8.x release, and its dev deps
  are `^7.10.1`. The one trap is the CLI: `prisma@latest` is now 8.0.0-rc.23, so an unpinned `pnpm add -D prisma` or
  `pnpm dlx prisma` gets a CLI that refuses a Prisma 7 config and has no `generate` or `migrate dev`.
- **Prisma 8 can't express the planned 5.0 search table.** It has no `tsvector` or `point` column type and its Prisma 7
  compatibility mode rejects `Unsupported(...)` outright (verified). `Prisma.sql`, `$queryRaw` and `$transaction` are
  gone, replaced by `db.raw.sql` and `db.transaction`. JSON-path filtering, which the documented `meta.draft`
  visibility pattern uses, is "not yet available".
- **Multi-file schemas now exist in 8 and follow symlinks** (verified), so the earlier "Prisma 8 lacks multi-file
  schemas" finding (issue #82, from prisma/orm#30157) is out of date. That doesn't rescue 8 for arocapi, because the
  models themselves would need Prisma 8 syntax.
- **Recommendation: 5.0 targets Prisma 7 only**, with peer `"@prisma/client": "^7.0.0"` (dropping 6, which loses
  security support on 19 November 2026). Revisit 8 in a later major once it is GA, has `tsvector`/`point` (or
  arocapi changes design), JSON filtering and a story for libraries that accept a consumer's client. Prisma 7 gets
  fixes for 18 months after 8 reaches GA. See [Recommendation](#recommendation).

## 1. What Prisma 8 is

- **Status.** "Prisma ORM 8 is a **release candidate**"; "General availability is expected in October 2026". Not yet
  available: "`$extends`, filtering inside JSON columns, atomic `increment`, most nested writes, transaction isolation
  levels, and `P2002`-style error codes" ([release status][status]). Breaking changes still land between RCs: rc.18
  changed how full-text indexes are stored and made raw SQL in a contract a `sql` literal ([v8.0.0-rc.18][rc18]).
- **Support for 7.** Prisma 7 "keeps receiving bug fixes and security updates for 18 months" from 8's GA. Prisma 6
  gets "security patches, but no other updates" until 19 November 2026 ([release status][status]).
- **Packages.** Prisma 8 ships as "the `prisma` CLI and a per-database library (`@prisma/orm-postgres`,
  `@prisma/orm-mongo`)". "`npm install prisma` and `npx prisma` now install the Prisma 8 CLI, which does not read
  `schema.prisma` and lacks `generate`, `migrate dev`, and `db push`" ([release status][status]). npm dist-tags on
  20 October 2026: `prisma` `latest` = 8.0.0-rc.23, `prev` = 7.10.1; `@prisma/client` `latest` = 7.10.1.
- **No generated client.** "There is no generated `PrismaClient`"; `prisma generate` becomes `prisma contract emit`,
  which writes `contract.json` and `contract.d.ts`; `generator` blocks are removed ([coming from 7][from7]). The
  client is `postgres<Contract>({ contractJson, url })` from `@prisma/orm-postgres/runtime` (verified in the package
  types and the `prisma orm init` scaffold).
- **Side by side.** The official [upgrade guide][upgrade] runs both in one app against one database in five phases;
  Prisma 7 keeps migration ownership until phase 4, when `db sign` adopts the database.

## 2. Touchpoint by touchpoint

### 2.1 Peer dependency and accepting the consumer's client

- arocapi declares `peerDependencies: { "@prisma/client": ">=6" }` and types `Options.prisma` as `PrismaClient` from
  its own generated client (`src/generated/prisma/client.js`). Every query is a delegate call
  (`prisma.entity.findMany`, `.findFirst`, `.count`, `prisma.file.*`).
- `@prisma/client` has no 8.x stable release and won't get one ([release status][status]), so `>=6` admits no Prisma 8
  package. (`@prisma/client` `8.1.0-dev.*` builds exist on the `dev` tag; their purpose isn't documented.)
- A Prisma 8 `db` has none of the delegates: queries are `db.orm.public.Entity.where({...}).first()`,
  `findUnique` becomes `.where(...).first()`, and `where` takes an object or a callback ([coming from 7][from7]).
- **(verified)** The published 4.0.1 tarball doesn't contain `dist/generated`, so `dist/app.d.ts`'s
  `import type { PrismaClient } from './generated/prisma/client.js'` doesn't resolve for consumers, and with
  `skipLibCheck` (which the install docs recommend) `Options['prisma']` is `any`: assigning it to a `number`
  type-checks. So nothing stops a consumer passing a Prisma 8 `db`; it would compile and then fail at runtime on
  `prisma.entity`. Current `main` has the same layout.

**Impact: breaks** (if a consumer tries 8). Today's range is safe only because no `@prisma/client` 8 exists.

### 2.2 The symlinked multi-file schema

- Prisma 7: unchanged; `schema: 'prisma'` folder plus `prisma/arocapi -> ../node_modules/arocapi/prisma/models`
  works (issue #82 research).
- Prisma 8 native: `contract` takes a glob, and "Every matching file that starts with `// use prisma-8` becomes part
  of one contract"; files without the directive are silently skipped ([PSL syntax][psl], [configuration][config]).
  This landed in [prisma/orm#30379][p30379] (merged 22 September 2026), after the comment in
  [prisma/orm#30157][p30157] that it "did not make it to RC"; that issue is still open but stale.
- **(verified)** With `contract: './prisma/**/*.prisma'` and `prisma/arocapi` a symlink to another folder, `contract
  emit` loaded both files, resolved an `EntitySearch → Entity` relation across them, and `db init --dry-run` planned
  `FOREIGN KEY ("id") REFERENCES "public"."entity" ("id") ON DELETE CASCADE`. The glob goes through `tinyglobby`
  (#30379), which follows symlinks.
- Prisma 8 compatibility mode: `prisma7Schema(path)` "takes one schema file, or a directory of `.prisma` files as
  Prisma ORM 7 reads it" ([configuration][config]). **(verified)** Pointing it at a folder holding a Postgres
  `schema.prisma` (with both of arocapi's `generator` blocks) and the symlinked `prisma/models` emits a contract; the
  generator blocks are ignored.
- The model files themselves are not portable: Prisma 8 PSL needs the `// use prisma-8` first line, writes native
  types as the field type (`VarChar(768)` not `String @db.VarChar(768)`), and `Json` means Postgres `json`, not
  `jsonb` ([coming from 7][from7]). One file can't serve both versions (inference: the directive makes a file Prisma
  8-only, and Prisma 7 can't parse the new type syntax).

**Impact: changes.** The symlink mechanism survives; the files behind it would need a Prisma 8 rewrite.

### 2.3 Client generation, output and prisma-json-types-generator

- `generator client { provider = "prisma-client" output = ... }` and `prisma generate` have no Prisma 8
  equivalent; `contract emit` writes `contract.json`/`contract.d.ts`, which you commit ([coming from 7][from7]).
- prisma-json-types-generator 5.2.0 peers on `prisma` and `@prisma/client` `^7.8.0`; it's a Prisma 7 generator with
  no Prisma 8 path. arocapi configures it but has no `/// [Type]` comments in its models, so it currently does
  nothing.

**Impact: breaks** under 8 (generators are gone); **unaffected** on 7.

### 2.4 Json field typing

- Prisma 7: `meta Json?` is `JsonValue`; consumers cast (`file.meta as FileMeta`).
- Prisma 8: write `Jsonb` to keep 7's behaviour; `type X { ... }` value-object blocks give a typed `jsonb` column
  ([PSL syntax][psl], [Prisma 8 blog][blog]). **(verified)** Under `prisma7Schema`, `meta Json?` becomes
  `pg/jsonb@1`, and `DateTime` columns come back as strings (`TimestampString<3>`), as the upgrade guide warns.
- "Filtering inside JSON (`path`, `string_contains`, `array_contains`)" is not available ([coming from 7][from7]).
  arocapi's documented draft-hiding filter (`website/examples/reference/entity-meta-draft.ts`) and the integration
  test use `meta: { path: '$.draft', ... }`, so that visibility pattern has no Prisma 8 form yet. (Separately, on
  Postgres in Prisma 7, `path` is a `string[]`, not a MySQL `$.draft` string, so the 5.0 docs need that rewrite
  regardless.)

**Impact: breaks** (JSON-path visibility filters); typing **changes** for the better.

### 2.5 `$queryRaw`, `Prisma.sql` and the `Prisma` namespace

- Prisma 8: "`Prisma.sql`, `Prisma.join`, `Prisma.raw`, `Prisma.empty`, and TypedSQL are not available. … Use
  `db.raw.sql`". Rows go through `.returnsRow(...).build()` and `db.runtime().query()`; `${...}` values are still
  parameters ([coming from 7][from7], [raw queries][raw]). Since rc.18 "the `sql` tag interpolates other `sql`
  values, so predicates compose" ([rc.18][rc18]). Identifiers can't be interpolated ([raw queries][raw]).
- `Prisma.EntityWhereInput` (the `entityVisibilityFilter` return type) and `Prisma.AnyNull` disappear with the
  generated client; types come from `contract.d.ts` ([coming from 7][from7]).

**Impact: breaks.** Composition is still possible, through a different API.

### 2.6 `$transaction` and tx clients

- Prisma 8: `db.transaction(async (tx) => ...)`, querying through `tx.orm`; raw queries via `tx.query`/`tx.execute`.
  No `isolationLevel`, `timeout`, `maxWait` or nested transactions ([coming from 7][from7], [raw queries][raw]).
- A `{ tx }` passed to `PostgresBackend.index` would be a Prisma 7 interactive-transaction client or a Prisma 8 `tx`,
  never interchangeable (inference: different objects from different packages, and the upgrade guide only says the
  two clients share a database, not transactions).

**Impact: breaks** under 8; **unaffected** on 7.

### 2.7 Driver adapters

- Prisma 8 has no driver adapters; "The Postgres facade takes a pre-built `pg.Pool` or `pg.Client` through the `pg:`
  binding" ([blog][blog]). **(verified)** `postgres()` options accept `url`, `pg: Pool | Client` or `binding`, and
  `@prisma/orm-postgres` depends on `pg` 8.22.0.
- `@prisma/adapter-pg` remains the Prisma 7 way; the 5.0 test setup is unaffected while arocapi stays on 7.

**Impact: changes** (adapter replaced by a `pg` binding); 5.0 on 7 **unaffected**.

### 2.8 Migrations, `tsvector` and `point`

- **(verified)** `prisma7Schema` on a model with `Unsupported("tsvector")` and `Unsupported("point")` fails:
  "`PSL.PRISMA7_UNSUPPORTED_TYPE` … has no Prisma 8 codec yet, and Prisma 8 cannot read this schema until it supports
  the column type. `@@ignore` on model "EntitySearch" does not help". So a 5.0 schema with the planned `EntitySearch`
  can't even run side by side under 8's compatibility mode.
- **(verified)** Native Prisma 8 PSL has no such types: `Tsvector` and `Point` fail with `PSL_UNRESOLVED_REFERENCE`.
  The rc.18 Postgres target registers codecs for `tsquery` but not `tsvector` or `point`. The PSL docs list no
  `Unsupported` escape hatch, only extension packs such as `pgvector.Vector` and `postgis.Geometry`
  ([PSL syntax][psl], [blog][blog]).
- What Prisma 8 does have: `@@fullTextIndex([[name], description], name: ...)`, a weighted GIN **expression** index,
  queried with `fns.fullTextMatches` / `fns.fullTextRank` ([rc.18][rc18]). **(verified)** It plans
  `CREATE INDEX … USING "gin" ((setweight(to_tsvector('english', coalesce("name", '')), 'A') || …))`. That is
  a different design from the ADR 0003 table (stored, per-field `tsvector` columns, a GiST `point`, a geohash), which
  issue #74's research chose over expression indexes.
- Migrations move to `migration plan` + `db migrate`; `migrate reset` and `db seed` have no equivalent
  ([coming from 7][from7]). Consumers' committed `prisma/migrations` stay Prisma 7's until a `db sign` handover
  ([upgrade guide][upgrade]).

**Impact: breaks** (the planned schema is not representable).

### 2.9 `prisma.config.ts`

- Prisma 8 uses the same filename but a different shape: `definePrismaConfig({ orm: defineConfig({ contract, db,
  output, migrations, extensions }) })`, with `definePrismaConfig` from `@prisma/cli-engine` (or `prisma/config`) and
  `defineConfig` from `@prisma/orm-postgres/config` ([configuration][config]; verified via `prisma orm init`).
- **(verified)** The Prisma 8 CLI walks up from the working directory collecting every `prisma.config.ts` up to the
  directory containing `.git`, and refuses one without its version marker: "`CLI.CONFIG_MISSING_MARKER` … it is most
  likely a Prisma 7 config, which uses the same filename — and the CLI stops rather than misread it". Running
  `prisma@8` anywhere inside the arocapi repo (or a consumer's) fails on the Prisma 7 config.
- arocapi's own config imports `@prisma/config` (7.x, a runtime dependency) and is published in `files`; under 8 it
  would be dead weight (inference).

**Impact: breaks** under the 8 CLI; **unaffected** with the 7 CLI.

## 3. Impact summary

| Touchpoint | Prisma 8 | arocapi on 7 |
| --- | --- | --- |
| `@prisma/client` peer, accepting the consumer's client | Breaks: no `@prisma/client`, no delegates | Unaffected; tighten to `^7` |
| Symlinked multi-file schema | Changes: glob + `// use prisma-8` works through symlinks; model files need rewriting | Unaffected |
| Client generation, prisma-json-types-generator | Breaks: no generators, `contract emit` instead | Unaffected (generator is unused) |
| Json typing and `meta` filters | Changes typing (`Jsonb`, typed `type` blocks); breaks JSON-path filters | Unaffected |
| `$queryRaw`, `Prisma.sql`, `Prisma` namespace | Breaks: `db.raw.sql`, contract types | Unaffected |
| `$transaction`, `{ tx }` | Breaks: `db.transaction`, `tx.orm`, no isolation levels | Unaffected |
| Driver adapters | Changes: `pg` binding replaces `@prisma/adapter-pg` | Unaffected |
| Migrations, `tsvector`/`point` | Breaks: types not representable, compat mode refuses `Unsupported` | Unaffected |
| `prisma.config.ts` | Breaks: new shape, 8 CLI refuses 7 configs | Unaffected; pin the CLI |

## Recommendation

**5.0 targets Prisma 7 only.** Concretely:

- Peer `"@prisma/client": "^7.0.0"` (or a higher 7.x floor if 5.0 needs a 7.x feature). This drops 6, which loses
  security support on 19 November 2026, and states the 7 dependency explicitly instead of relying on there being no
  `@prisma/client` 8. A peer range can't exclude a Prisma 8 `db`, because that comes from a different package.
- Keep dev deps on `^7.x`. Keep the docs' `prisma@7` and `@prisma/client@7` pins and pin every `prisma` command and
  `pnpm dlx` to 7, since `prisma@latest` is 8.
- Consider failing fast at registration when `options.prisma` lacks an `entity` delegate, since the published types
  give consumers `any` (inference: a cheap guard; the same gap affects any wrong object today).
- Keep the ADR 0003 `EntitySearch` design; nothing in 8 forces a change for 5.0. Note in the ADR or upgrade docs that
  5.0 requires Prisma 7.

**Not "support both".** The two have no shared query API, raw SQL API, transaction object, types or schema syntax,
so supporting both means two data layers and two model sets inside one library, plus a compat mode that refuses the
5.0 schema. **Not "adopt 8"** for 5.0: it's an RC with breaking changes between RCs, and it can't express the search
table.

**Triggers to revisit (a 6.0 question, not 5.0):**

- Prisma 8 is GA and has stopped breaking between releases.
- Prisma 8 supports `tsvector` and `point` columns (or an `Unsupported` escape hatch), or arocapi decides its
  search table could use `@@fullTextIndex` expression indexes and PostGIS instead.
- Prisma 8 ships JSON filtering, so `entityVisibilityFilter` over `meta` has a Prisma 8 form.
- Prisma documents how a library should accept a consumer's client typed by the library's own models (for example a
  contract space or extension pack). arocapi would then ship a contract, not models to symlink.
- Prisma 7's end of fixes approaches: 18 months after 8's GA, so about April 2028 if GA is October 2026
  (inference from the stated window).

[status]: https://www.prisma.io/docs/orm/release-status
[from7]: https://www.prisma.io/docs/orm/coming-from-prisma-orm-7
[upgrade]: https://www.prisma.io/docs/guides/upgrade-prisma-orm/postgresql
[config]: https://www.prisma.io/docs/cli/configuration
[psl]: https://www.prisma.io/docs/orm/contract-authoring/psl-syntax
[raw]: https://www.prisma.io/docs/orm/reference/raw-queries
[blog]: https://www.prisma.io/blog/prisma-orm-8-closes-330-most-requested-issues
[rc18]: https://github.com/prisma/orm/releases/tag/v8.0.0-rc.18
[p30379]: https://github.com/prisma/orm/pull/30379
[p30157]: https://github.com/prisma/orm/issues/30157
