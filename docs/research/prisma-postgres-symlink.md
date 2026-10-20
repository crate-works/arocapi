# Research: can Prisma replace the prisma/postgres symlink?

Question (issue #82, map #71): can a current Prisma feature (7.x or 8) let a Postgres consumer pick up arocapi's
search models from `node_modules/arocapi/prisma/postgres` without symlinking the folder beside `prisma/models`? Do
cross-folder relations (search table → `Entity`, cascade) still work, and what version floor does it set against the
`@prisma/client >=6` peer range? Researched 20 October 2026 against Prisma 7.10.1 (current `prev` tag) and Prisma 8
(`8.0.0-rc.23`, the npm `latest` tag).

## Answer in brief

- **Prisma 7: no.** `schema` in `prisma.config.ts` is a single `string`, either a file or one folder. There is no
  array, glob, include or import. The only ways to get files from `node_modules` into the schema are a symlink, or
  copying them in. Keep the symlink.
- **Symlinks are supported, not a hack.** The schema loader deliberately follows file and directory symlinks, and has
  done since multi-file schemas got subfolder support (June 2024). Verified on 7.10.1: a symlinked
  `prisma/arocapi-postgres -> ../node_modules/arocapi/prisma/postgres` loads, validates and produces the expected
  `CREATE TABLE`, `USING GIN` index and `ON DELETE CASCADE` foreign key.
- **Prisma 8 could, but it isn't an option.** Its `contract` setting takes a glob, and a custom contract source can
  load files from anywhere. But Prisma 8 is a release candidate, a ground-up rewrite with no `@prisma/client`, and its
  Prisma 7 compatibility mode rejects `Unsupported(...)`. Adopting it means rewriting arocapi, not raising a floor.
- **No new version floor.** Following symlinked folders needs nothing beyond what consumers already rely on to link
  `prisma/models`: a multi-file schema, GA in Prisma 6.7.0. The `@prisma/client >=6` peer range is unaffected. (Before
  6.7 it needed the `prismaSchemaFolder` preview flag.)
- **Watch out: the relation needs a field on `Entity`.** This holds whatever the folder layout. A Prisma `@relation`
  from `EntitySearch` to `Entity` fails validation unless `Entity` has the opposite field. If that field goes in the
  shared `prisma/models`, MySQL consumers, who don't link `prisma/postgres`, fail with "Type `EntitySearch` is neither a
  built-in type…". Verified on 7.10.1. Issue #74's design has to settle where the opposite field lives (see section 4).

## 1. Prisma 7: how the schema is located

The config type in `@prisma/config` 7.10.1 (`dist/index.d.ts`) reads:

```ts
/**
 * The path to the schema file, or path to a folder that shall be recursively searched for *.prisma files.
 */
schema?: string;
```

The [Config API reference][config-v7] says it "Can be a file or folder path", resolved relative to the config file,
and that with a multi-file schema "your `migrations` directory must be located next to the `.prisma` file that
defines the `datasource` block". The [schema location page][location-v7] adds that "you must always explicitly specify
the location of the directory that contains your schema files", either with `--schema` or the `schema` config
property. Neither page offers multiple paths, globs or imports.

The open feature request [prisma/orm#27964][p27964], "support modular `schema.prisma` files outside the `prisma/`
directory", asks for this and has no maintainer response. [prisma/orm#2377][p2377], "Support for splitting Prisma
schema into multiple files", was closed in June 2025 once the folder form shipped, not an import mechanism.

## 2. Prisma 7: symlinks are followed by design

`packages/schema-files-loader/src/loadSchemaFiles.ts` ([7.9.x branch][loader-src]) walks the folder recursively. A
`symlink` entry is resolved to its real path and processed as whatever it points to, so linked files and linked
folders are both loaded. History:

- [prisma/orm#24378][p24378] (merged 2024-06-03), "Support subfolders", introduced the recursive walk. Per
  [#29740][p29740], "Directory symlinks used to be skipped entirely before #24378". The `symlink` branch is present at
  the 6.0.0, 6.7.0 and 7.0.0 tags.
- [prisma/orm#29740][p29740], shipped in [7.9.0][r790], tracks visited directories by canonical path. Before it, a
  symlink cycle hung `prisma validate`, and a folder reachable under two paths had its files loaded twice ("a model
  with that name already exists"). Neither happens with a plain link into `node_modules`, so 7.9.0 isn't a floor.
- Multi-file schemas went GA in [6.7.0][r670] ("The `prismaSchemaFolder` Preview feature is moving into General
  Availability"), after breaking changes to the preview in 6.6.0.

**Local test (Prisma CLI 7.10.1, Postgres provider).** Layout:

```
prisma/
├── schema.prisma                 # generator + datasource
├── arocapi -> ../node_modules/arocapi/prisma/models
└── arocapi-postgres -> ../node_modules/arocapi/prisma/postgres
```

with `EntitySearch { entityId … @id; entity Entity @relation(fields: [entityId], references: [id], onDelete: Cascade);
search Unsupported("tsvector")?; @@index([search], type: Gin) }` in the linked postgres folder. Results:

1. Without an opposite field on `Entity`: `prisma validate` fails with "The relation field `entity` on model
   `EntitySearch` is missing an opposite relation field on the model `Entity`", reported at
   `node_modules/arocapi/prisma/postgres/search.prisma:3`. This confirms the linked file was loaded.
2. With `search EntitySearch?` added to `Entity`: validation passes, and `prisma migrate diff --from-empty
   --to-schema prisma --script` emits `CREATE TABLE "entity_search"` with a `tsvector` column,
   `CREATE INDEX … USING GIN ("search")`, and `FOREIGN KEY ("entityId") REFERENCES "entity"("id") ON DELETE CASCADE
   ON UPDATE CASCADE`.
3. With that `Entity` field but no postgres link (a MySQL consumer): validation fails with "Type `EntitySearch` is
   neither a built-in type, nor refers to another model, composite type, or enum."

Relations across folders therefore work. A schema folder is one merged schema, so the only requirement is that both
ends of the relation are in it.

## 3. Prisma 8: globs, but a different product

Prisma 8 is a "ground-up TypeScript rewrite" ([llms.txt][llms]). Its [release status][status] says it is "a
**release candidate**", with "General availability … expected in October 2026". The CLI is `8.0.0-rc.23` and
`@prisma/orm-postgres` is `8.0.0-rc.18`. "`@prisma/client`, the library that Prisma ORM 7 apps import, stays at
`7.10.1`". Prisma 7 gets fixes for 18 months after 8 reaches GA, and Prisma 6 gets security patches until
19 November 2026.

- **Globs.** "`contract` accepts a glob … so one schema can span several `.prisma` files", for example
  `"./prisma/**/*.prisma"` ([CLI configuration][config-v8]). Only files whose first line is `// use prisma-8` count,
  and the emitted `contract.json`/`contract.d.ts` go "in the folder before the first wildcard". A single glob
  reaching both `prisma/` and `node_modules/arocapi/…` would need brace alternation, which the docs don't mention.
- **Custom sources.** A config can build `contract.source` "as an object with a `load` function" (same page). This
  could read files out of `node_modules` with no link at all.
- **Why it doesn't apply.** There is "no generated `PrismaClient`". Apps import a `db` built from emitted files
  ([Coming from Prisma ORM 7][from7]), and the Postgres library is `@prisma/orm-postgres`, not `@prisma/client`.
  `prisma7Schema(...)` lets Prisma 8 read a Prisma 7 schema, but "`contract emit` fails on any part of the schema
  that Prisma ORM 8 cannot represent exactly, such as … `Unsupported(...)`" ([CLI configuration][config-v8]), which
  rules out the planned `Unsupported("tsvector")` columns. Prisma 8 offers `@@fullTextIndex` and its own
  full-text query functions instead ([PSL syntax][psl-v8]), so it calls for a different search design.

Supporting Prisma 8 would replace the `@prisma/client >=6` peer dependency outright. That's a separate decision from
this ticket.

## 4. Consequence for #74: where the opposite relation field lives

Section 2 shows a declared Prisma relation needs `EntitySearch` on `Entity`, which the shared `prisma/models` can't
carry without breaking MySQL. Options, for whoever picks up the design:

- Postgres consumers link a `prisma/postgres` folder that holds the full Postgres model set (its own `Entity` with the
  opposite field, plus the search models) **instead of** `prisma/models`. That means two copies of `Entity` to keep in
  step, which a generator or CI check can enforce.
- Declare no Prisma `@relation`, and add the FK in a hand-written migration. Prisma would see the FK as drift, and the
  consumer owns the SQL. The earlier research on Postgres search through Prisma (#77) already notes this.
- A one-sided relation, or extending a model from another file, isn't available in Prisma 7. `prisma format` would
  just add the missing opposite field.

[config-v7]: https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference#schema
[location-v7]: https://www.prisma.io/docs/orm/v7/prisma-schema/overview/location#multi-file-prisma-schema
[p27964]: https://github.com/prisma/orm/issues/27964
[p2377]: https://github.com/prisma/orm/issues/2377
[loader-src]: https://github.com/prisma/orm/blob/7.9.x/packages/schema-files-loader/src/loadSchemaFiles.ts
[p24378]: https://github.com/prisma/orm/pull/24378
[p29740]: https://github.com/prisma/orm/pull/29740
[r790]: https://github.com/prisma/orm/releases/tag/7.9.0
[r670]: https://github.com/prisma/orm/releases/tag/6.7.0
[llms]: https://www.prisma.io/docs/llms.txt
[status]: https://www.prisma.io/docs/orm/release-status
[config-v8]: https://www.prisma.io/docs/cli/configuration#split-the-schema-across-several-files
[from7]: https://www.prisma.io/docs/orm/coming-from-prisma-orm-7
[psl-v8]: https://www.prisma.io/docs/orm/contract-authoring/psl-syntax
