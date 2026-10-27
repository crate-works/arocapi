# arocapi

arocapi implements the [RO-Crate API](https://ro-crate-api.crate-works.org) for data collections, packaged as a
Fastify plugin. You mount it into your own Fastify app and bring your storage, search index and access
rules; arocapi serves the routes for entities, files, search and RO-Crate metadata, following the
[PILARS](https://w3id.org/ldac/pilars) protocols for long-term archival repositories.

**Documentation: <https://arocapi.crate-works.org>**

- [What is arocapi](https://arocapi.crate-works.org/introduction/what-is-arocapi/)
- [Getting started](https://arocapi.crate-works.org/getting-started/install/)
- [Configuration](https://arocapi.crate-works.org/configuration/data-sources/)
- [Routes](https://arocapi.crate-works.org/reference/routes/)

## Install

```sh
pnpm add arocapi
```

v5 is in beta, and the documentation site describes it. Until it is released, install it with
`pnpm add arocapi@beta`. Changes merged to `main` are published under the `beta` tag.

The v4 documentation is the [README at the v4.0.1 tag](https://github.com/crate-works/arocapi/blob/v4.0.1/README.md).

## Development

You need Node.js 22.18 or later, pnpm, and Docker with Docker Compose.

```sh
pnpm install
docker compose up -d   # Postgres, OpenSearch and the Oni UI
pnpm generate          # generate the Prisma client
pnpm db:migrate        # apply migrations
pnpm seed              # load the sample data in example/data
pnpm dev               # build and serve src/index.dev.ts on http://localhost:9000
```

`.env` holds the local connection URLs and is committed, so don't put secrets in it.

| Command                       | What it does                                                       |
| ----------------------------- | ------------------------------------------------------------------ |
| `pnpm lint`                   | Biome, type checking, the docs examples type check and knip        |
| `pnpm test`                   | Start the test containers, apply migrations and run every test     |
| `pnpm test src/app.test.ts`   | Run one test file                                                  |
| `pnpm test:watch`             | Run the tests in watch mode                                        |
| `pnpm test:coverage`          | Run the tests with an HTML coverage report                         |
| `pnpm dbconsole`              | Open a psql console on the development database                    |
| `pnpm --filter website dev`   | Run the documentation site locally                                 |
| `pnpm --filter website build` | Build the documentation site, checking its diagrams and every link |

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/); they decide the next version.
See [TESTING.md](TESTING.md) for the test setup and [RELEASING.md](RELEASING.md) for releases.
