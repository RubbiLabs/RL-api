# Rubbi API — Integration Guide (Stellar)

Backend for Rubbi on Stellar: SEP-10 authentication, an event indexer that mirrors the vault, subscriptions and payroll contracts, card loads and unloads through the vault, and a virtual card from a mock issuer (or Sudo Africa). Part of the Rubbi repos: [RL-smart-contracts](https://github.com/RubbiLabs/RL-smart-contracts) (Soroban contracts) and [RL-frontend](https://github.com/RubbiLabs/RL-frontend).

Design document: [PRD.md](PRD.md). Swagger UI: `GET /docs`.

## Base URL

```
http://localhost:3000/api/v1
```

All endpoints return JSON. Amounts are USDC as decimal strings with up to 7 decimals (`"12.5"`), never numbers.

---

## The wallet-vs-card model

Every user has two balances:

| Balance | What it is | Who changes it |
|---|---|---|
| `walletBalance` | mirror of the user's USDC in the on-chain **vault** | only the indexer, from vault events (`deposit`, `withdraw`, `card_spend_settled`, `refund_credited`) |
| `cardBalance` | USDC loaded on the virtual card at the issuer | card loads/unloads (after the issuer step) and card spend / refund webhooks |

Money is in exactly one place at a time:

1. **Deposit**: the user signs `vault.deposit` from their wallet. The indexer credits `walletBalance`. Nothing happens to the card.
2. **Load the card** (`POST /cards/load`): the backend's operator moves the amount from the user's vault to Rubbi's treasury on-chain (`settle_card_spend`, idempotent by reference), then funds the card at the issuer and credits `cardBalance`. `walletBalance` goes down when the indexer sees the settlement event.
3. **Spend**: the issuer's webhook debits `cardBalance`. No chain action.
4. **Unload the card** (`POST /cards/unload`): the issuer defunds the card, `cardBalance` goes down, then the treasury moves the amount back into the user's vault (`credit_refund`). `walletBalance` goes up when the indexer sees the refund event. Without a treasury key on the API host the unload waits in `PENDING_TREASURY` for an operator (`bun run process-pending-unloads`).
5. **Withdraw**: the user signs `vault.withdraw`. Only wallet money can be withdrawn; card money is no longer in the vault.

Poll `GET /cards/movements` for the status of loads and unloads (`PENDING → SETTLED → COMPLETED`, or `FAILED` / `PENDING_TREASURY`).

---

## Authentication (SEP-10)

1. `GET /auth/challenge?account=G...` → `{ transaction, network_passphrase }` (a challenge transaction, base64 XDR, signed by the server, valid 5 minutes).
2. Sign `transaction` with the user's wallet (Stellar Wallets Kit `signTransaction`, network passphrase as returned).
3. `POST /auth/token { transaction }` → `{ token, user }`.
4. Send `Authorization: Bearer <token>` on protected routes. `sub` of the JWT is the Stellar account id, verbatim (addresses are case-sensitive).

```ts
const { transaction, network_passphrase } = await api.get(`/auth/challenge?account=${address}`)
const { signedTxXdr } = await kit.signTransaction(transaction, { networkPassphrase: network_passphrase, address })
const { token } = await api.post("/auth/token", { transaction: signedTxXdr })
```

Limits: only the account's master key is accepted (multisig accounts and contract accounts / passkey wallets are backlog items: Horizon signer lookup, SEP-45). Contract ids (`C...`) are rejected with 400.

Onboarding: after the token, `GET /users/me` returns `username: null` and `card: null`; `POST /users/username { username }` (3–32 chars, `[a-z0-9_]`, once per address) sets it and creates the card. Mock cards have `issuer: "MOCK"`; show the badge.

---

## Error format

```json
{ "statusCode": 400, "error": "Bad Request", "message": "..." }
```

| Code | Meaning | Common causes |
|---|---|---|
| 400 | Bad Request | invalid input, amount above the available balance, SEP-45 account |
| 401 | Unauthorized | missing or expired JWT, rejected challenge, invalid webhook HMAC |
| 404 | Not Found | user / card / deposit / plan / schedule not found |
| 409 | Conflict | username already set or taken, card not active |
| 429 | Too Many Requests | 120/min per IP; auth routes 30/min; webhooks 600/min |

---

## Endpoints

### System and configuration

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ status, service, timestamp }` |
| GET | `/stellar/config` | — | `{ network, networkPassphrase, rpcUrl, usdcSacId, contracts: { vault, subscriptions, payroll }, sep10 }` — use this instead of hard-coding ids |

### Auth and users

| Method | Path | Auth | Body / Returns |
|---|---|---|---|
| GET | `/auth/challenge?account=G...` | — | `{ transaction, network_passphrase }` |
| POST | `/auth/token` | — | `{ transaction }` → `{ token, user: { id, stellarAddress, username } }` |
| GET | `/users/me` | JWT | `{ id, stellarAddress, username, walletBalance, cardBalance, card }` |
| POST | `/users/username` | JWT | `{ username }` → same shape as `/users/me` |

### Cards

| Method | Path | Auth | Body / Returns |
|---|---|---|---|
| GET | `/cards/me` | JWT | `{ id, issuer, issuerId, last4, expiryMonth, expiryYear, status, cardBalance, walletBalance }` |
| POST | `/cards/freeze` / `/cards/unfreeze` | JWT | `{ reason? }` → `{ status }` |
| GET | `/cards/me/number` | JWT | `{ cardId, issuer, pan, last4, ... }` — `pan` is always `null` for MOCK |
| POST | `/cards/load` | JWT | `{ amount }` → 202 + movement. 400 when above `walletBalance` minus loads in flight |
| POST | `/cards/unload` | JWT | `{ amount }` → 202 + movement. 400 when above `cardBalance` minus unloads in flight |
| GET | `/cards/movements` | JWT | `[{ id, direction, amount, status, reference, txHash, failureReason, createdAt, settledAt, completedAt }]` |

### Ledgers

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/deposits` | JWT | vault deposits: `[{ id, txHash, eventId, amountRaw, amount, status, ledger, confirmedAt, createdAt }]` |
| GET | `/deposits/:txHash` | JWT | one deposit (64-hex Stellar tx hash) |
| GET | `/transactions?page=&pageSize=&account=WALLET|CARD` | JWT | `{ page, pageSize, total, items: [{ id, type, account, amount, balanceAfter, description, metadata, createdAt }] }`. `amount` is the signed delta on `account`; rows with `metadata.informational` (subscription charges, payroll) did not change a balance |

### Subscriptions (read-only mirror)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/subscriptions/plans?includeInactive=` | — | `[{ id, merchant, name, amount, period, active }]` |
| GET | `/subscriptions/plans/:planId` | — | one plan |
| GET | `/subscriptions/me` | JWT | `[{ id, onChainSubId, subscriber, planId, status, nextDueAt, lastChargedAt, createdAt, plan }]` |

Subscribe, pause, resume and cancel are **wallet-signed contract calls** (`subscribe`, `pause_subscription`, `resume_subscription`, `cancel_subscription`). Before `subscribe`, approve the USDC SAC for `plan.amount × N` periods with an expiration ledger covering them. The mirror updates when the indexer sees the event (a few seconds).

### Payroll (read-only mirror)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/payroll/schedules` | JWT | schedules where the caller is the employer |
| GET | `/payroll/schedules/incoming` | JWT | schedules that pay the caller |
| GET | `/payroll/schedules/:scheduleId` | JWT | one schedule (employer or recipient only) |

Schedule shape: `{ id, onChainId, employer, recipient, amount, period, label, status, nextDueAt, lastDisbursedAt, createdAt }`. Fund, withdraw escrow, create, pause, resume, cancel and the manual "Pay due now" (`disburse`) are wallet-signed; escrow is read on-chain with `escrow_of`.

### Dashboard

`GET /dashboard/stats` (JWT) → `{ walletBalance, cardBalance, activeSubscriptions, pastDueSubscriptions, activeSchedules, incomingSchedules, recentTransactions }`.

### Webhooks and development

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/webhooks/card-issuer` | HMAC (`x-sudo-signature`) | issuer events: authorization requests answered from `cardBalance`; purchases debit it; refunds credit it |
| POST | `/dev/mock-card-spend` | — | `{ userId, amount, merchantName?, merchantCategory? }` → runs a signed purchase webhook through the real handler. Registered only when `NODE_ENV !== production` and `CARD_ISSUER=mock` |

---

## Integration patterns

**Wallet-signed, mirror-confirmed.** Every contract write (deposit, withdraw, subscribe, payroll) is built, simulated and signed in the frontend and submitted to Soroban RPC. The backend learns about it through events; poll the relevant read endpoint until the mirror reflects it. Nothing has to be "confirmed" with the API.

**Backend-signed, polled.** Card loads and unloads are the only flows where the backend signs on-chain (operator / treasury). They are asynchronous: `POST` returns 202 with a movement; poll `GET /cards/movements`.

**Testnet funds.** XLM from Friendbot (`stellar keys fund` or Stellar Lab), USDC from Circle's testnet faucet; the account needs a USDC trustline (`changeTrust`) before it can hold USDC.

---

## Local development

```bash
cp .env.example .env            # contract ids for testnet are already filled in
POSTGRES_PORT=5435 REDIS_PORT=6380 docker compose -f docker-compose.dev.yml up -d db redis
bun install
bunx prisma generate
bunx prisma migrate deploy
bun run dev
```

Adjust `DATABASE_URL` / `REDIS_URL` in `.env` to the ports you chose. Ports: the API listens on **3000** (`PORT`) and the frontend dev server on **3001**, so `CORS_ORIGINS` defaults to `http://localhost:3001` (exact origins, comma-separated; the JWT goes in the `Authorization` header, so no cookies or credentials are involved). See [README.docker.dev.md](README.docker.dev.md).

Checks: `bun run typecheck`, `bun test` (set `TEST_DATABASE_URL` to also run the Postgres-backed suites). CI runs both with Postgres and Redis service containers.

Secrets: the `.env.example` seeds are the all-zero placeholder, valid for development and rejected in production. Real operator, keeper and SEP-10 keys belong in the deployment's secret store; the treasury key is optional and best kept off the API host (`TREASURY_SECRET=S... bun run process-pending-unloads`).

---

## Contracts and roles

| Item | Testnet value |
|---|---|
| vault | `CBGARSQ7BY4345DNX76LWT4VXEHRRFJMNW46SCX7DRHBILL5V6RJN6KR` |
| subscriptions | `CDWMLKAUMXHLSBOKKCK5A4ECUP2VIIHXAL7MVQ5TEFLE3QUXZRMDC3PC` |
| payroll | `CB76PQ2MTILAQJAHLMTRHYDODX7H73YUCTVVKYO46ME3MK6WUTELDGYU` |
| USDC SAC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| operator (signs `settle_card_spend`) | `GASCJCM7CLBWKKJ7UKXISRX67YRQD2EVL57YKPRCCTTECEZQYRJEPNXN` |
| treasury (signs `credit_refund`) | `GDRCO5PHUXNGQSM5CB752AWDCYID2VCCCUNF2QVA3GAWV7UB6QMEB4T5` |
| keeper (signs `charge_batch` / `disburse_batch`) | `GAL5BE6C7TTJXOZ2OIZXDTJX6K56ZOBUGEFOF3GE2OQUXACSA34N3WSQ` |

Contract error codes are mirrored in `src/lib/stellar/errors.ts`; the authoritative tables are in the contracts README.

---

## DB models (for reference)

**User:** id, stellarAddress (unique), username (unique, once), walletBalance, cardBalance, card (1:1)
**Card:** id, userId, issuer (MOCK|SUDO), issuerId, last4, expiryMonth, expiryYear, status
**Deposit:** id, userId, txHash, eventId (unique), amountRaw (stroops), amount, status, ledger
**Transaction:** id, userId, type, account (WALLET|CARD), amount (signed), balanceAfter, description, metadata
**CardMovement:** id, userId, direction (LOAD|UNLOAD), amount, reference (unique), status, txHash, failureReason, compensatesId
**SubscriptionPlan / Subscription / PayrollSchedule:** mirrors of the contracts (see PRD.md §7)
**ChainCursor / ProcessedEvent / ChainGap:** indexer state
