# Rubbi API — production image (Render "docker" runtime, or any container host).
#
# Runtime: Bun 1.4.4 on Debian 13 (the version pinned in .github/workflows/ci.yml).
# The base image ships openssl 3 and ca-certificates, which Prisma's query
# engine needs, and a non-root user `bun` (uid 1000) that the app runs as.
#
# Start-up (scripts/docker-entrypoint.sh): `bunx prisma migrate deploy`, then
# `bun run src/server.ts`. The HTTP server, the chain indexer, the keeper and
# the card-movement workers all run in this one process (see src/app.ts), so a
# single web service is enough.
#
# The server binds 0.0.0.0:$PORT (default 3000; Render injects PORT=10000).
FROM oven/bun:1.4.4

WORKDIR /app
RUN chown bun:bun /app
USER bun

# Dependencies first so the layer is cached across source changes. Dev
# dependencies stay installed on purpose: the `prisma` CLI runs the migrations
# at container start.
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --no-progress

# Prisma client (schema + migrations are needed at runtime by `migrate deploy`).
COPY --chown=bun:bun prisma ./prisma
RUN bunx prisma generate

COPY --chown=bun:bun . .

ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
