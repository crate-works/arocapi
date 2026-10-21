#!/usr/bin/env bash
# Type-check test/consumer against a freshly packed tarball, so only the files the package ships are available
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
consumer=$root/test/consumer
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

stage=$tmp/stage
mkdir -p "$stage/prisma" "$tmp/extract"
cp "$root/package.json" "$root/README.md" "$stage/"
cp -r "$root/prisma/models" "$stage/prisma/models"
"$root/node_modules/.bin/tsc" -p "$root" --emitDeclarationOnly --outDir "$stage/dist"
(cd "$stage" && pnpm pack --pack-destination "$tmp" >/dev/null)
tar -xzf "$tmp"/arocapi-*.tgz -C "$tmp/extract"

rm -rf "$consumer/node_modules/arocapi" "$consumer/src/generated"
mkdir -p "$consumer/node_modules"
mv "$tmp/extract/package" "$consumer/node_modules/arocapi"

cd "$consumer"
DATABASE_URL=postgresql://unused PRISMA_HIDE_UPDATE_MESSAGE=1 "$root/node_modules/.bin/prisma" generate >/dev/null
"$root/node_modules/.bin/tsc" -p "$consumer"
