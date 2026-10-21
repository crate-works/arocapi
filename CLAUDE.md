# CLAUDE.md

## What is this

arocapi is a **published npm library** (not a standalone app). It provides an RO-Crate API as a Fastify plugin. Changes must be mindful of the public API surface, semver implications, and peer dependencies (`@prisma/client`). The package is released via semantic-release.

## Commands

- `pnpm lint` — generate the Prisma client, then run biome, type checking, the docs examples type check (`website/examples/`), the consumer type check (`test/consumer/` against a packed tarball, via `scripts/check-consumer-types.sh`) and knip in parallel
- `pnpm test` — start test containers (docker-compose.test.yml), apply migrations, then run all tests with coverage. Concurrent runs across checkouts are serialised by a lock
- `pnpm test:ci` — run tests without starting containers (CI provides its own services)
- `pnpm test <file>` — run a single test file, e.g. `pnpm run test src/routes/entity.test.ts`
- `pnpm test:watch` — watch mode
- `pnpm test:coverage` — tests with HTML coverage report
- `pnpm generate` — generate Prisma client (run after schema changes)
- `pnpm db:migrate` — apply database migrations
- `pnpm --filter website build` — build the docs site (`website/`, Astro Starlight): checks every Mermaid diagram parses, then `astro build` with starlight-links-validator, which fails on a broken internal link or anchor. Examples are type-checked by `pnpm lint`, not here
- `pnpm --filter website dev` — docs dev server

Every push to `main` publishes a `beta` prerelease. Read `RELEASING.md` before merging or pushing to `main`.

## Architecture

This is a Fastify plugin that registers routes for entities, files, search, and RO-Crate metadata. Consumers register it with required configuration: `prisma`, `search`, `entityVisibilityFilter`, `searchVisibilityFilter`, `access`, `storage`.

**Visibility**: Every query is filtered by the consumer's `entityVisibilityFilter` (Prisma) and `searchVisibilityFilter` (a shared filter language every search backend applies), so hidden entities never appear in results, totals or facets. Visibility guards the Record, runs before access, and is separate from it. See `docs/adr/0001-entity-visibility-filters.md`.

**Access**: The consumer's `access` function decides, per entity, whether a request may read its Metadata and Content. The library attaches the result to every entity/file response and enforces it on `/entity/:id/metadata` and `/file/:id` (Denied → 401 if anonymous per `isAuthenticated`, else 403) before calling `storage.metadata`/`storage.content`. A file's access is its file entity's access. See `docs/adr/0002-library-enforces-access.md`.

**Transformation pipeline**: Every entity/file response flows through: base transformer → library attaches `access` → optional entity/file transformers (chained). This is the core extension mechanism.

**Search**: `/search` goes through the consumer's `search: SearchBackend` (`src/search/backend.ts`). The route validates the request against `backend.capabilities`, the backend returns ordered ids, an exact total and facets, and the route loads Records, attaches access and runs transformers. `OpenSearchBackend` (`src/search/opensearch/`) and `PostgresBackend` (`src/search/postgres/`) are the reference backends, configured by field declarations (`src/search/fields.ts`). See `docs/adr/0003-pluggable-search-backends.md`.

**Storage**: `storage: StorageBackend` (`src/storage/backend.ts`) has two halves: `metadata(entity)` and `content(file, entity)`, each returning a delivery (`stream`, `path`, `redirect`, or `json` for Metadata only) or `null` for a 404. The library turns the delivery into the response (`src/storage/deliver.ts`), sending HEAD the same headers as GET. `DirectoryStorage`, `S3Storage`, `OcflStorage` and `EntityMetaMetadata` (`src/storage/*/`) are the reference backends, finding items from default `meta` keys or a consumer's `locate`. See `docs/adr/0004-pluggable-storage-backends.md`.

**Prisma**: Uses folder-based schema (`prisma/` directory with `prisma.config.ts`). Models in `prisma/models/`. Generated client output goes to `src/generated/prisma/`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `crate-works/arocapi` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
