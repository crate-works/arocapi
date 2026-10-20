# Prisma 8: what changes from Prisma 7, and why

Researched 2026-10-20 against `prisma/orm` at commit `2a437dd` (2026-10-19), the npm registry, and
prisma.io docs and blog. **Verified** = read in a primary source (linked). **Inference** = my
reading, labelled as such.

## TL;DR

- Prisma 8 is **not an incremental major**. It's a ground-up TypeScript rewrite, developed as "Prisma
  Next" (`prisma/prisma-next`, now archived) and moved into `prisma/orm` (the renamed
  `prisma/prisma`). Prisma 7 lives on the `v7` branch.
- It's at **release candidate** (`8.0.0-rc.18` libraries, `8.0.0-rc.23` CLI). GA is "expected in
  October 2026" per the docs, or "in the next four to eight weeks" per the README.
- **`@prisma/client` is a Prisma 7 package.** Prisma 8 replaces it with per-database façades
  (`@prisma/orm-postgres`, `@prisma/orm-mongo`, `@prisma/orm-sqlite`). There's no `PrismaClient`, no
  `prisma generate` and no driver adapters.
- **Databases:** Postgres and MongoDB are first-class, and SQLite is a proof of concept. **MySQL and
  MariaDB are not supported**: "MySQL follows after SQLite". This matters for arocapi, which uses
  `provider = "mysql"` with `@prisma/adapter-mariadb`.
- **`npm install prisma` now installs the Prisma 8 CLI.** `prisma@latest` is `8.0.0-rc.23`. Caret
  ranges like `^7.10.1` are safe because pre-releases don't match them.

## 1. Release status and where it lives

| Fact | Source |
| --- | --- |
| `prisma/prisma` now resolves to `prisma/orm` (GitHub API `full_name`) | `gh api repos/prisma/prisma` |
| Prisma 7 source lives on the [`v7` branch](https://github.com/prisma/orm/tree/v7). Last commit 2026-10-09; it still ships fixes (7.10.1 on 2026-10-19) | [README](https://github.com/prisma/orm/blob/main/README.md), [releases](https://github.com/prisma/orm/releases) |
| Prisma 8 began as `prisma/prisma-next` (created 2025-10-31, now archived). Early releases were `0.12`–`0.17`, then `8.0.0-rc.1` on 2026-08-07. The latest library release is `rc.18` (2026-10-14) | [v8.0.0-rc.1 notes](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.1), `gh release list` |
| Announced 2026-03-04 as "Prisma Next" Early Access | [blog: The Next Evolution of Prisma ORM](https://www.prisma.io/blog/the-next-evolution-of-prisma-orm) |
| "An RC respin may still contain breaking changes" until `8.0.0` final. Every RC ships an upgrade recipe | [versioning.md](https://github.com/prisma/orm/blob/main/docs/oss/versioning.md) |
| GA: "expected in October 2026" (docs). "Expected in the next four to eight weeks" (README) | [release status](https://www.prisma.io/docs/orm/release-status), [README](https://github.com/prisma/orm/blob/main/README.md) |
| Prisma 7 support: bug fixes and security updates for **18 months after 8.0.0 GA**. The March blog said 12 months, so this was later extended | README, release status, blog |
| Prisma 6: security patches only, until 19 November 2026 | [release status](https://www.prisma.io/docs/orm/release-status) |

npm dist-tags, checked 2026-10-20 with `pnpm view <pkg> dist-tags`:

| Package | `latest` | Notes |
| --- | --- | --- |
| `prisma` (CLI) | `8.0.0-rc.23` | `prev` = `7.10.1`. CLI shim built in [prisma/prisma-cli](https://github.com/prisma/prisma-cli) and versioned separately from the libraries |
| `@prisma/orm-postgres`, `@prisma/orm-toolchain` | `8.0.0-rc.18` | New v8 packages |
| `@prisma/client`, `@prisma/config`, `@prisma/adapter-pg`, `@prisma/adapter-mariadb` | `7.10.1` | Prisma 7 packages |

**Inconsistency:** [versioning.md](https://github.com/prisma/orm/blob/main/docs/oss/versioning.md)
says `prisma` keeps `latest` on Prisma 7 "until `8.0.0` final", but the registry and the
[release status page](https://www.prisma.io/docs/orm/release-status) show `latest` already on 8.
The docs warn: "`npm install prisma` and `npx prisma` now install the Prisma 8 CLI, which drops
`generate`, `migrate dev`, and `db push`." Pin `prisma@7`.

**Unconfirmed:** `@prisma/client` has a `dev` tag at `8.1.0-dev.9` (2026-10-09). I couldn't find
what publishes it; the `v7` branch's `packages/client/package.json` says `0.0.0`. It's probably a
v7 pipeline artefact, not a Prisma 8 client.

## 2. Architecture and why

### The rationale

- From the blog: "we feel we've reached the limits of what we can achieve with the current
  codebase". The goal is to be "extensible" and "composable" by default, and AI agents change how
  software is built. The blog gives no deeper justification for TypeScript beyond "keep your schema
  in the same language as your application".
  ([blog](https://www.prisma.io/blog/the-next-evolution-of-prisma-orm))
- From [ARCHITECTURE.md](https://github.com/prisma/orm/blob/main/ARCHITECTURE.md): Prisma 7 "tightly
  couples three layers — the Prisma Schema Language (PSL), the generated client, and runtime
  execution. This coupling introduces rigidity, rebuild cost, and conceptual opacity." Prisma 8
  rethinks the data layer "around a **contract-first model**". The schema becomes "a stable,
  versioned artifact … not fuel for codegen, but a data contract".
- Agent-friendliness is an explicit design goal: the contract JSON is machine-readable, plans are
  inspectable ASTs, and agent skills ship inside the packages
  ([README](https://github.com/prisma/orm/blob/main/README.md), ARCHITECTURE.md § Agent-Accessible
  Design).

### What changed

| Area | Prisma 7 | Prisma 8 | Why (stated) |
| --- | --- | --- | --- |
| Engine | Already Rust-free in 7 (TS query compiler and driver adapters, [to-v7 guide](https://www.prisma.io/docs/v6/orm/more/upgrades/to-v7)) | Full TypeScript rewrite of everything: the schema parser, migrations and introspection too, not just the query path | Blog and ARCHITECTURE.md, above |
| Codegen | `prisma generate` emits a JS client | `prisma contract emit` emits only `contract.json` (IR, hashed) and `contract.d.ts`; **no generated JS** | [ADR 007](https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20007%20-%20Types%20Only%20Emission.md): generated clients "hide the underlying data contract semantics that agents and tools need to inspect"; regenerating on every change "is at odds with modern TS-first flows" |
| Client | `new PrismaClient({ adapter })` from `@prisma/client` | A `db` from `src/prisma/db.ts`, built from a target façade (`@prisma/orm-postgres/runtime`) | Façades "bake in the family / target / adapter / driver wiring" ([quickstart ref](https://github.com/prisma/orm/blob/main/skills/prisma-8/references/quickstart.md)) |
| Packages | `prisma`, `@prisma/client`, `@prisma/config`, `@prisma/adapter-*` | `prisma` (CLI) plus `@prisma/orm-{postgres,mongo,sqlite}`, which depend on `@prisma/orm-{framework,toolchain,family-sql,target-*}`. Extensions are `@prisma/orm-extension-*` | Layered domains (framework / family / target / extension), so "Postgres support itself, is built on the same public SPI that's available to any author" (README) |
| Driver adapters | Required (`@prisma/adapter-pg` etc.) | Gone as a user concept. `@prisma/orm-postgres` depends on `pg` directly | Inference: folded into the target façade |
| Query API | `prisma.user.findMany({ where, include })` | Chained: `db.orm.public.User.where(...).include(...).all()`, plus a typed SQL builder (`sql().from(...)`) | Blog: replaces "deeply nested include/select objects"; plans are "verifiable and transparent; no hidden multi-query behaviors" (ARCHITECTURE.md) |
| Extensibility | `$extends` | Middleware (`beforeCompile`/`afterExecute`/`onError`), extension packs, `Collection` subclasses. `$extends` is **not** carried over | ARCHITECTURE.md § Extensible Middleware; [Coming from 7](https://www.prisma.io/docs/orm/coming-from-prisma-orm-7) |
| Errors | `P2002`-style codes | Structured envelopes with dotted codes (`ORM.ARGUMENT_INVALID`); use `code`/`sqlState` | [v0.17.0 notes](https://github.com/prisma/orm/blob/main/docs/releases/v0.17.0.md) |
| Types | `Prisma.User`, `UserGetPayload<…>` | `Models.public_User`, `Scalars<M>`, `Shape<M, Spec>`, `ResultType` | [rc.10 notes](https://github.com/prisma/orm/blob/main/docs/releases/v8.0.0-rc.10.md) |
| Values | `Date`, `number` counts | `DateTime` is `Temporal.Instant` (needs `temporal-polyfill` on Node 22/24); `count()` is `bigint` | [Coming from 7](https://www.prisma.io/docs/orm/coming-from-prisma-orm-7), [rc.1 notes](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.1) |
| Migrations | Linear `migrations/` folder, `_prisma_migrations` | A graph of contract-to-contract **edges** with a DB marker hash (`prisma_contract.marker`), pre- and post-checks, an advisory lock, squash and baseline | [ADR 001](https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20001%20-%20Migrations%20as%20Edges.md): file-order coupling "makes squashing brittle, and complicates collaboration when branches diverge"; agents and CI need "deterministic, machine-verifiable answers" |

## 3. Schema (PSL) changes

The schema is now called the **contract** (`contract.prisma` or a TypeScript `contract.ts` builder).
Mapping from [Coming from Prisma ORM 7](https://www.prisma.io/docs/orm/coming-from-prisma-orm-7),
paraphrased:

- The `generator` block is removed. The `datasource` block moves into `prisma.config.ts` (no
  `provider`; the façade package picks the database).
- `@db.*` becomes the field type (`String @db.VarChar(255)` → `VarChar(255)`). `Json` now means
  Postgres `json`; use `Jsonb` for `jsonb`.
- `dbgenerated(...)` → `` sql`...` `` tagged literal
  ([rc.12](https://github.com/prisma/orm/blob/main/docs/releases/v8.0.0-rc.12.md),
  [ADR 268](https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20268%20-%20Raw%20SQL%20is%20a%20value%20of%20the%20data%20type%20sql-expression.md)).
- `@updatedAt` → `temporal.updatedAt()`. `cuid()` → `cuid(2)`. `@@schema("x")` → `namespace x {}`.
- Enums are stored as text by default; native Postgres enums are opt-in.
- Implicit many-to-many is gone; you write the join model yourself.
- A model without `@@map` names its table **exactly as written**
  ([rc.12](https://github.com/prisma/orm/blob/main/docs/releases/v8.0.0-rc.12.md),
  [ADR 264](https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20264%20-%20A%20model%20names%20its%20storage%20verbatim%2C%20and%20a%20rename%20is%20an%20operation.md)).
- Every PSL file needs `// use prisma-8` as its first line (since rc.12). Files without it are
  **silently left out**.

### Multi-file schemas: [prisma/orm#30157](https://github.com/prisma/orm/issues/30157)

- The issue (opened 2026-08-28) reports that Prisma 8 accepted a single contract file only. A
  maintainer (SevInf) said multi-file "did not made it to RC but are coming soon … before 8.0.0
  stable".
- **Shipped in `8.0.0-rc.12`** via [#30379](https://github.com/prisma/orm/pull/30379) (merged
  2026-09-24). `contract` takes a glob such as `'./prisma/**/*.prisma'`. Every matching file whose
  first line is `// use prisma-8` joins one schema, and new files join on the next emit. Output goes
  to the glob's static prefix (`./prisma/contract.json`), and `orm format` formats every member.
  The PR's stated reason: "Schemas grow past one file; classic Prisma users already organize
  schemas across files."
- Language server support followed in `rc.14`
  ([#30456](https://github.com/prisma/orm/pull/30456)).
- **The issue is still OPEN** as of 2026-10-20 even though the PR merged.
- **Gap:** split **TypeScript** contracts ([#30177](https://github.com/prisma/orm/issues/30177))
  are not covered by #30379. Extensionless imports fail with `CONTRACT.SOURCE_LOAD_FAILED`; the
  workaround is `.ts` imports with `allowImportingTsExtensions`.
- Prisma 7 directory schemas read through `prisma7Schema()` keep their directory loading
  (`contract-prisma7` is untouched, per the PR).

## 4. Config, raw SQL, migrations, CLI

### `prisma.config.ts`

`prisma.config.ts` is still the config file. It now uses `definePrismaConfig` from `prisma/config`,
wrapping `defineConfig` from `@prisma/orm-postgres/config`, with keys `contract`, `db.connection`,
`output`, `extensions` and `migrations`
([upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/postgresql)). The guide never
mentions `@prisma/config`. **Inference:** `@prisma/config` stays a Prisma 7-only package.

From rc.12 onwards, `@prisma/cli-engine` no longer exports `defineConfig`. A hand-written contract
source must declare `format`
([rc.13](https://github.com/prisma/orm/blob/main/docs/releases/v8.0.0-rc.13.md)).

### Raw SQL

[Scorecard 13](https://github.com/prisma/orm/blob/main/scorecard/13-raw-and-typed-sql.md) marks
**`Prisma.sql`, `Prisma.join`, `Prisma.raw`, `Prisma.empty` and TypedSQL ❌ not in 8.0**.

- `$queryRaw`/`$executeRaw` become `db.raw.sql` with `.returnsRow(spec)` or `.affectedCount()`, run
  through `db.runtime()`.
- A `rawSql` expression is also available inside the typed builder.
- Design:
  [ADR 247](https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20247%20-%20Whole-query%20raw%20SQL%20is%20the%20fragment%20mechanism%20at%20statement%20position.md).

### Transactions

- Only the callback `db.transaction(async tx => …)` form exists. The array form is gone.
- `isolationLevel`, `timeout`, `maxWait` and nested transactions are ❌
  ([scorecard 14](https://github.com/prisma/orm/blob/main/scorecard/14-transactions.md)).

### CLI

| Prisma 7 | Prisma 8 |
| --- | --- |
| `generate` | `contract emit` |
| `migrate dev` | `db update`, or `migration plan` then `db migrate` |
| `migrate deploy` | `db migrate` |
| `db push` | `db init`, then `db update` |
| `db pull` | `contract infer` |
| `migrate reset`, `db seed`, `studio`, `validate` | None |

New commands: `orm init`, `db sign` and `db verify` (drift detection against the marker).

Source: [Coming from 7](https://www.prisma.io/docs/orm/coming-from-prisma-orm-7).

### Not yet available

From the [release status](https://www.prisma.io/docs/orm/release-status) page and
[Coming from 7](https://www.prisma.io/docs/orm/coming-from-prisma-orm-7):

- `$extends` and atomic `increment`/`decrement`
- Most nested writes (beyond `create`/`connect`/`disconnect`)
- JSON path filters, `omit`, `relationLoadStrategy` and `findUnique` batching
- `has`/`hasSome` list filters
- `mode: "insensitive"` (use `ilike`)
- Read replicas and `P2xxx` codes

The full feature matrix is in [scorecard.md](https://github.com/prisma/orm/blob/main/scorecard.md).

### Preview features

There's no `generator` block, so there's no `previewFeatures`. The only one the migration docs
mention is `fullTextSearchPostgres`, which is replaced by `fullTextMatches`/`fullTextRank` query
functions (shipped in rc.12). **Not confirmed:** a complete preview-feature disposition list.

## 5. Supported versions

| | Prisma 7 | Prisma 8 |
| --- | --- | --- |
| Node | ≥ 20.19 | Docs and CLI `engines`: `^22.18 \|\| ^24.11 \|\| >=26`. The repo's [Supported Versions.md](https://github.com/prisma/orm/blob/main/docs/Supported%20Versions.md) and [ADR 222](https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20222%20-%20Version%20support%20policy.md) say ≥ 24. **These conflict; the user-facing docs are more recent** |
| TypeScript | ≥ 5.4 | ≥ 5.9 (optional peer), `strict` and `moduleResolution: "bundler"` |
| Module system | ESM | ESM-only; JSON import attributes required |
| Postgres | — | ≥ 15 ([ADR 248](https://github.com/prisma/orm/blob/main/docs/architecture%20docs/adrs/ADR%20248%20-%20PostgreSQL%20floor%20lowered%20to%2015.md)) |
| MongoDB | (v6 only) | ≥ 8.0 |
| SQLite | Yes | Proof of concept |
| MySQL / MariaDB / SQL Server / CockroachDB | Yes | **No.** "MySQL follows after SQLite" (README); no date |

The floor policy is "the supported floor for each dependency is the latest GA release we test
against": start aggressive, lower on demand (ADR 222).

## 6. Upgrade path from 7

The official guide is
[Migrate from Prisma 7 to Prisma 8](https://www.prisma.io/docs/guides/upgrade-prisma-orm/postgresql).
It is **Postgres only** and was validated against `prisma` 8.0.0-rc.21 and `@prisma/orm-postgres`
rc.16. It runs both versions side by side in five phases:

1. Move Prisma 7 to `@prisma/prisma7` (`prisma7` binary, `prisma7.config.ts`).
2. Add Prisma 8 (CLI plus `@prisma/orm-postgres`, a separate config and contract).
3. Migrate route by route against the same database.
4. Hand migration ownership to Prisma 8. This is one-way: `contract infer` → `db sign` → the first
   `migration plan` writes a baseline, and `_prisma_migrations` becomes inert.
5. Remove `@prisma/prisma7`, `@prisma/client` and `@prisma/adapter-pg`.

Alternatives:

- `prisma7Schema('prisma/schema.prisma')` reads a Prisma 7 schema directly as the contract (rc.12,
  Postgres). `prisma orm init --from-prisma7-schema` sets it up.
- Behaviour through `prisma7Schema` has been shifting between RCs:
  - DateTimes read as text strings (rc.15).
  - Constraint names are preserved (rc.17).
  - `@ignore` keeps its storage (rc.18).

During the RC period, each release ships an agent-applied upgrade recipe under
`skills/prisma-8/upgrading/`
([upgrade-instructions README](https://github.com/prisma/orm/blob/main/upgrade-instructions/README.md)).

## 7. Relevance to arocapi (inference)

- arocapi uses `provider = "mysql"`, `@prisma/adapter-mariadb`, `@prisma/config`, a directory
  schema (`schema: 'prisma'`), `prisma-json-types-generator`, and a peer dependency on
  `@prisma/client >=6`. **Prisma 8 has no MySQL/MariaDB target, no `@prisma/client`, no generators,
  and a different query API**, so arocapi can't adopt Prisma 8 until MySQL lands.
- Even after that, adopting Prisma 8 would be a breaking change to arocapi's public API, because
  consumers pass in a `PrismaClient`.
- The 18-month Prisma 7 support window after 8.0 GA gives runway. Watch the README and
  [scorecard](https://github.com/prisma/orm/blob/main/scorecard.md) for MySQL.
- Our `^7.10.1` ranges are safe; RC pre-releases don't satisfy them. Risks are ad-hoc
  `npx prisma`/`pnpm dlx prisma` (now Prisma 8) and any unpinned `prisma@latest` in CI or docs.
- Prisma 8 doesn't use `prisma-json-types-generator`. JSON typing moves to codecs and Standard
  Schema (ADR 168, the `arktype-json` extension).

## Couldn't confirm

- An exact GA date. The two primary sources differ ("October 2026" vs "four to eight weeks").
- A MySQL/MariaDB timeline, or any v8 plan for SQL Server/CockroachDB.
- What publishes `@prisma/client@8.1.0-dev.*`.
- The Node floor: docs and CLI say 22.18+, the repo ADR says 24+.
- A complete list of how each Prisma 7 preview feature fares.
- Why `prisma@latest` moved to 8 before final, contrary to versioning.md.
