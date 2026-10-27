# Docker dev setup

`docker-compose.dev.yml` runs PostgreSQL, Redis and (optionally) the API.

## Database and Redis only (recommended for development)

```bash
docker compose -f docker-compose.dev.yml up -d db redis
```

Host ports default to 5432 (Postgres) and 6379 (Redis). If those are taken, pick others; the containers do not care:

```bash
POSTGRES_PORT=5435 REDIS_PORT=6380 docker compose -f docker-compose.dev.yml up -d db redis
```

Then point `.env` at them (`DATABASE_URL=postgresql://rubbi:rubbi@localhost:5435/rubbi`, `REDIS_URL=redis://localhost:6380`) and run:

```bash
bun install
bunx prisma generate
bunx prisma migrate deploy
bun run dev
```

## Whole stack

```bash
docker compose -f docker-compose.dev.yml up --build
```

The `api` service reads `.env`, overrides `DATABASE_URL` / `REDIS_URL` to the in-network services, runs `prisma db push` on start and listens on `${API_PORT:-3000}`.

## Tests that need Postgres

```bash
docker exec rubbi-postgres-dev psql -U rubbi -d rubbi -c "CREATE DATABASE rubbi_test;"
DATABASE_URL=postgresql://rubbi:rubbi@localhost:5435/rubbi_test bunx prisma migrate deploy
TEST_DATABASE_URL=postgresql://rubbi:rubbi@localhost:5435/rubbi_test bun test
```

Without `TEST_DATABASE_URL` the `tests/db` suites are skipped; everything else runs against an in-memory fake.

## Stop

```bash
docker compose -f docker-compose.dev.yml down
```
