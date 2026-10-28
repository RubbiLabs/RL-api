#!/bin/sh
# Container entrypoint: apply pending Prisma migrations, then start the API.
# `migrate deploy` is idempotent (it only applies migrations that are not yet
# recorded in _prisma_migrations), so every restart is safe. If a migration
# fails the container exits non-zero and the deploy is marked failed, instead
# of serving requests against a schema the code does not expect.
set -eu

echo "[entrypoint] applying database migrations"
bunx prisma migrate deploy

echo "[entrypoint] starting rubbi-api on port ${PORT:-3000}"
exec bun run src/server.ts
