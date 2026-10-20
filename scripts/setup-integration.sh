#!/usr/bin/env bash

set -e

# All checkouts share one test stack; serialise runs so they don't wipe each other's data.
# The lock is inherited by the exec'd command and held until it exits.
if command -v flock >/dev/null; then
  exec 9>/tmp/arocapi-test.lock
  flock 9
fi

docker compose -f docker-compose.test.yml up --wait --detach

export DATABASE_URL='postgresql://postgres:password@localhost:5433/catalog_test'
prisma generate >/dev/null
prisma migrate deploy
prisma migrate diff --from-config-datasource --to-schema prisma --exit-code >/dev/null || {
  echo 'Migrations have drifted from the Prisma schema; run prisma migrate dev' >&2
  exit 1
}

if [ $# -gt 0 ]; then
  exec "$@"
fi
