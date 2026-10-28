# Deploying the Rubbi API to Render (testnet)

This guide walks through deploying `RL-api` from the `develop` branch to
[Render](https://render.com) with the Blueprint in [`render.yaml`](render.yaml):
one Docker web service (`rubbi-api`), one Render Postgres (`rubbi-db`) and one
Render Key Value instance (`rubbi-redis`, Valkey, Redis-compatible), all on the
free plan. The frontend is deployed separately to Vercel
(`RL-frontend/DEPLOY.md`) and talks to this service over HTTPS.

Everything here was checked against Render's docs on 2026-10-28
([Blueprint reference](https://render.com/docs/blueprint-spec),
[free instances](https://render.com/docs/free),
[Docker](https://render.com/docs/docker),
[health checks](https://render.com/docs/health-checks)).

## What the container does

- Image: `oven/bun:1.4.4` (Debian 13, openssl 3), runs as the non-root user
  `bun`. `bun install --frozen-lockfile`, then `bunx prisma generate`.
- Start: `scripts/docker-entrypoint.sh` runs `bunx prisma migrate deploy` and
  then `bun run src/server.ts`. A failed migration stops the deploy.
- One process serves HTTP and runs the chain indexer, the keeper
  (`charge_batch` / `disburse_batch` on `KEEPER_CRON`) and the card-movement
  workers (`src/app.ts`, `onReady` hook). No extra worker service is needed.
- Health check: `GET /health` returns `{ status: "ok", service: "rubbi-api", timestamp }`
  (unprefixed; the API routes live under `/api/v1`).
- The server binds `0.0.0.0:$PORT`. Render sets `PORT=10000`.

## Free-plan limits to know before you start

| Resource | Limit (Render docs, 2026-10-28) | Effect on Rubbi |
|---|---|---|
| Web service | Spins down after 15 minutes without inbound HTTP traffic; about 1 minute to wake; 750 free instance hours per workspace per month; single instance; ephemeral disk | While asleep the indexer and keeper do not run. See "Keeping the service awake". |
| Postgres | One free instance per workspace; 1 GB; no backups; **expires 30 days after creation**, then 14 days of grace before deletion | Upgrade the plan or recreate the database (and re-run migrations) before day 30. The API re-syncs its mirrors from chain events only from the saved cursor, so a fresh database starts from the latest ledger. |
| Key Value | One free instance per workspace; in-memory only, data lost on restart; persistence off; 25 MB, 50 connections | Queued card loads/unloads in flight are lost on a restart (they stay `PENDING` in Postgres and can be re-queued); the keeper schedule is re-created at every start (`upsertJobScheduler`). |
| Pre-deploy command | Paid instances only | Migrations run in the container entrypoint instead. |

## Before you begin

You need:

- A Render account with a workspace that has no other free Postgres or free
  Key Value instance (one of each per workspace).
- Push access to `RubbiLabs/RL-api`, with this work merged into `develop`
  (merging and pushing are the maintainers' actions; nothing in this guide is
  automated).
- The `stellar` CLI (28.1.0) with the testnet identities `rubbi-operator`,
  `rubbi-keeper` and `rubbi-treasury` in its keystore (the ones used by
  `RL-smart-contracts/scripts/deploy-testnet.sh`). Check they match the
  deployed roles in `RL-smart-contracts/deployments/testnet.json`:

  ```sh
  stellar keys public-key rubbi-operator   # GASCJCM7CLBWKKJ7UKXISRX67YRQD2EVL57YKPRCCTTECEZQYRJEPNXN
  stellar keys public-key rubbi-keeper     # GAL5BE6C7TTJXOZ2OIZXDTJX6K56ZOBUGEFOF3GE2OQUXACSA34N3WSQ
  stellar keys public-key rubbi-treasury   # GDRCO5PHUXNGQSM5CB752AWDCYID2VCCCUNF2QVA3GAWV7UB6QMEB4T5
  ```

  The operator and keeper accounts pay transaction fees, so keep a few XLM on
  each (Friendbot: `https://friendbot.stellar.org/?addr=<G...>`).
- `openssl` (for random secrets) and, on macOS, `pbcopy` (clipboard).

## Step 1 — Create the Blueprint

1. Render dashboard → **New +** → **Blueprint**.
2. Connect the `RubbiLabs/RL-api` repository and select branch **`develop`**
   (the Blueprint file is read from that branch, and the web service deploys
   from it).
3. Render shows the three resources from `render.yaml` and a form with every
   `sync: false` variable. Fill them in as described in Step 2, then
   **Apply**.

Everything with a fixed value (`NODE_ENV`, `STELLAR_*`, contract ids,
`CARD_ISSUER=mock`, `CORS_ORIGINS=https://rubbilabs.vercel.app`) and the two
datastore URLs (`DATABASE_URL`, `REDIS_URL`) are set by the Blueprint; do not
retype them.

If you prefer to create the service first and add the secrets afterwards, you
can enter placeholder text in the form and then edit the values under
**rubbi-api → Environment** before the first deploy finishes (the first deploy
will fail validation until the real values are there, which is harmless).

## Step 2 — The secrets, one by one

Rule: a secret is shown or copied on your machine and pasted into exactly one
place, the Render environment-variable field. It is never pasted into a
file, a chat, a shell history line, an issue or a commit.

The commands below pipe each value straight into the clipboard so it never
appears on screen (macOS `pbcopy`; on Linux use `xclip -selection clipboard`
or `wl-copy`). After pasting into Render, clear the clipboard:

```sh
pbcopy < /dev/null
```

Testnet keys only. Never do this with a mainnet identity.

### `OPERATOR_SECRET`, `KEEPER_SECRET`, `TREASURY_SECRET`

From the existing testnet identities:

```sh
stellar keys secret rubbi-operator | pbcopy    # paste as OPERATOR_SECRET
stellar keys secret rubbi-keeper   | pbcopy    # paste as KEEPER_SECRET
stellar keys secret rubbi-treasury | pbcopy    # paste as TREASURY_SECRET
```

`TREASURY_SECRET` is optional: with it, card unloads are credited back to the
vault automatically; without it, unloads stop in `PENDING_TREASURY` and are
processed from a trusted machine with
`TREASURY_SECRET=... bun run process-pending-unloads`. For the testnet demo,
set it. For anything closer to production, keep the treasury key off the API
host and leave the field empty (the Blueprint still declares it; an empty
value is treated as unset).

### `SEP10_SIGNING_SECRET`

A new identity, dedicated to signing SEP-10 challenges (it needs no funds for
signing; `--fund` creates and funds the account on testnet so it is a real,
inspectable account):

```sh
stellar keys generate rubbi-sep10 --network testnet --fund
stellar keys secret rubbi-sep10 | pbcopy        # paste as SEP10_SIGNING_SECRET
stellar keys public-key rubbi-sep10             # record this G... in your notes
```

The public key is what the frontend (and anyone) can use to verify challenges;
if you later serve a `stellar.toml`, publish it there as `SIGNING_KEY`.

### `JWT_SECRET` and `SUDO_WEBHOOK_SECRET`

Random 32-byte hex strings (64 characters; `JWT_SECRET` must be at least 32):

```sh
openssl rand -hex 32 | pbcopy    # paste as JWT_SECRET
openssl rand -hex 32 | pbcopy    # paste as SUDO_WEBHOOK_SECRET
```

`SUDO_WEBHOOK_SECRET` is required in production even under `CARD_ISSUER=mock`
(the config refuses to start without it); it is the HMAC key the webhook
handler checks. Nothing calls the webhook on testnet with the mock issuer, but
the value must exist.

### `HOME_DOMAIN` and `WEB_AUTH_DOMAIN`

Both are the Render service's host, without scheme or path. With the service
name `rubbi-api` from the Blueprint it is normally `rubbi-api.onrender.com`,
but Render may add a suffix if the name is taken; read the exact host from the
service page (it is also exposed to the container as
`RENDER_EXTERNAL_HOSTNAME`). Enter the same host for both:

```
HOME_DOMAIN=rubbi-api.onrender.com
WEB_AUTH_DOMAIN=rubbi-api.onrender.com
```

If you attach a custom domain later, change both and redeploy; SEP-10
challenges embed these values and the frontend's sign-in will fail if they do
not match the host the browser talks to.

### Rotating a secret

Edit the variable under **rubbi-api → Environment** and save; Render redeploys.
Rotating `JWT_SECRET` logs every user out (the JWT lives in the browser
session only). Rotating `OPERATOR_SECRET` or `KEEPER_SECRET` requires the
contract roles to be rotated too (`set_operator` by the admin; the keeper
needs no on-chain role, only XLM for fees).

## Step 3 — First deploy

Render builds the image (`Dockerfile`), creates the database and the Key
Value instance, and starts the container. In **rubbi-api → Logs** expect:

```
[entrypoint] applying database migrations
2 migrations found in prisma/migrations
The following migration(s) have been applied: 20260411000000_init, 20261027000000_stellar
[entrypoint] starting rubbi-api on port 10000
Server listening at http://<container-ip>:10000
"component":"indexer" ... "indexer starting from ledger (no saved cursor)"
```

(On later deploys the migration step prints `No pending migrations to apply`.)

The deploy is marked live once `GET /health` answers `2xx`.

Common first-deploy failures:

| Log line | Cause | Fix |
|---|---|---|
| `Invalid environment variables:` followed by `X_SECRET cannot be the all-zero placeholder in production` or `must be a Stellar secret seed` | A secret field was left as a placeholder or pasted with whitespace | Re-copy the secret; check for a trailing newline (the `pbcopy` commands above include none). |
| `JWT_SECRET: String must contain at least 32 character(s)` | Short secret | Use `openssl rand -hex 32`. |
| `SUDO_WEBHOOK_SECRET must be set explicitly in production` | Field empty | Set it (Step 2). |
| `P1001: Can't reach database server` | Database still provisioning | Render retries; redeploy manually if it does not recover within a few minutes. |
| `ECONNREFUSED` from ioredis | Key Value instance not ready or different region | The three resources must share a region (`frankfurt` in the Blueprint). |

## Step 4 — Verify

Replace the host with your service's host.

```sh
curl -s https://rubbi-api.onrender.com/health | jq
# { "status": "ok", "service": "rubbi-api", "timestamp": "2026-..." }

curl -s https://rubbi-api.onrender.com/api/v1/stellar/config | jq
# {
#   "network": "testnet",
#   "networkPassphrase": "Test SDF Network ; September 2015",
#   "rpcUrl": "https://soroban-testnet.stellar.org",
#   "usdcSacId": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
#   "contracts": {
#     "vault": "CBGARSQ7BY4345DNX76LWT4VXEHRRFJMNW46SCX7DRHBILL5V6RJN6KR",
#     "subscriptions": "CDWMLKAUMXHLSBOKKCK5A4ECUP2VIIHXAL7MVQ5TEFLE3QUXZRMDC3PC",
#     "payroll": "CB76PQ2MTILAQJAHLMTRHYDODX7H73YUCTVVKYO46ME3MK6WUTELDGYU"
#   },
#   "sep10": { "homeDomain": "rubbi-api.onrender.com", "webAuthDomain": "rubbi-api.onrender.com" }
# }
```

Check `sep10.homeDomain` equals the host you are curling. Then:

- `curl -s "https://rubbi-api.onrender.com/api/v1/auth/challenge?account=GAL5BE6C7TTJXOZ2OIZXDTJX6K56ZOBUGEFOF3GE2OQUXACSA34N3WSQ" | jq .networkPassphrase`
  returns the testnet passphrase (any valid G address works; this one is the
  keeper's public key).
- CORS: `curl -s -i -X OPTIONS https://rubbi-api.onrender.com/api/v1/cards/load -H 'Origin: https://rubbilabs.vercel.app' -H 'Access-Control-Request-Method: POST' | grep -i access-control-allow-origin`
  prints `access-control-allow-origin: https://rubbilabs.vercel.app`.
- Swagger UI: `https://rubbi-api.onrender.com/docs`.
- `POST /api/v1/dev/mock-card-spend` must return `404`: dev routes are not
  registered under `NODE_ENV=production`. The mock-spend step of
  `E2E_CHECKLIST.md` therefore runs only against a local API.

The first request after a spin-down takes up to a minute (Render shows a
loading page); that is the free plan, not a fault.

## Keeping the service awake

On the free plan the process is frozen 15 minutes after the last inbound
request, and with it the indexer (deposits are mirrored late) and the keeper
(due subscriptions and salaries are not charged until the next wake-up). For a
demo that is acceptable: everything catches up within seconds of the next
request, and the contracts' time gates mean nothing is charged twice.

To keep it running continuously, point an external uptime monitor (for
example a free cron/ping service) at `https://<host>/health` every 10 minutes.
One always-on free service uses about 744 of the 750 free instance hours in a
31-day month, so run only this one free web service in the workspace, or
upgrade the plan.

## Updating

Every commit merged into `develop` redeploys automatically
(`autoDeployTrigger: commit`). A deploy builds the image, runs the migrations in the entrypoint and
switches traffic once `/health` is green; if the health check does not pass
within 15 minutes Render cancels the deploy and keeps the previous version.

To redeploy the same commit: **rubbi-api → Manual Deploy → Deploy latest
commit**. To change a public variable (for example the contract ids after a
contract redeploy), edit `render.yaml`, commit, push; Render applies Blueprint
changes on the next sync (**Blueprints → rubbi → Sync**) and redeploys.

## Optional variables (code defaults, not in the Blueprint)

Add under **rubbi-api → Environment** only if you need to change them.

| Variable | Default | Notes |
|---|---|---|
| `STELLAR_NETWORK_PASSPHRASE` | passphrase of `STELLAR_NETWORK` | |
| `INDEXER_POLL_INTERVAL_MS` | `5000` | minimum 500 |
| `INDEXER_START_LEDGER` | latest ledger | first run only; set it to the deployment ledger to backfill history |
| `KEEPER_CRON` | `*/10 * * * *` | |
| `KEEPER_HOLD_SECONDS` | `21600` | how long an unpayable payee is skipped |
| `JWT_EXPIRES_IN` | `24h` | |
| `SUDO_API_KEY`, `SUDO_BASE_URL`, `SUDO_DEFAULT_CUSTOMER_ID` | unset / `https://api.sudo.africa` | only with `CARD_ISSUER=sudo` |
| `CORS_ORIGINS` | set by the Blueprint | comma-separated exact origins; add Vercel preview origins here if you need them |

## Running the image locally

```sh
docker build -t rubbi-api .
docker run --rm -p 3000:3000 --env-file .env \
  -e DATABASE_URL=postgresql://rubbi:rubbi@host.docker.internal:5435/rubbi \
  -e REDIS_URL=redis://host.docker.internal:6380 \
  rubbi-api
curl -s localhost:3000/health
```

`.env` is your local development file (`.env.example` values are enough; the
placeholder secrets are accepted outside production). The image never
contains a `.env` file (`.dockerignore`).
