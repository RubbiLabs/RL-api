# Rubbi — Technical Product Requirements Document
### Backend API & Infrastructure
**Version:** 3.0.0
**Date:** October 2026
**Stack:** TypeScript · Fastify · Bun · Prisma · PostgreSQL · Redis · BullMQ · @stellar/stellar-sdk

---

## 1. Product overview

Rubbi is a Nigeria-focused payment automation platform on **Stellar**. Users hold USDC in their own wallet, deposit some of it into a Soroban **vault** to fund a virtual card, pay recurring subscriptions and bills through the **subscriptions** contract, and run recurring payroll through the **payroll** contract. The backend bridges three rails:

- **On-chain rails** — three Soroban contracts (vault, subscriptions, payroll) and USDC through its Stellar Asset Contract (SAC). Users sign every contract call themselves with their wallet; the backend only signs the operator, keeper and (optionally) treasury calls described below.
- **Internal ledger** — two balances per user, `walletBalance` (mirror of the on-chain vault balance) and `cardBalance` (issuer-side card balance), each with its own ledger rows.
- **Card issuer rails** — a virtual card from `MockCardIssuer` by default, or Sudo Africa behind `CARD_ISSUER=sudo`.

Amounts are USDC with 7 decimals everywhere: `i128` stroops on-chain, `Decimal(20,7)` in the database, decimal strings in the API. There is no RUBBI token, no faucet and no on-chain username registry anymore.

### 1.1 Wallet balance versus card balance

The vault is **custodial for card funding only**. A user's USDC in the vault is theirs to withdraw at any time, even while the vault is paused. Card money is different: when the card is loaded, the operator moves that USDC from the user's vault to Rubbi's treasury on-chain (`settle_card_spend`), and only then is the card funded at the issuer. Card spends are then settled off-chain against the treasury. This keeps one invariant simple:

> Money is in exactly one place. `walletBalance` mirrors the vault; `cardBalance` mirrors the card. A deposit never funds the card by itself, and a withdrawal can never take money the card has already spent.

| Flow | On-chain action | `walletBalance` | `cardBalance` |
|---|---|---|---|
| Deposit to vault (user signs `deposit`) | `deposit` event | + amount (indexer) | — |
| Withdraw from vault (user signs `withdraw`) | `withdraw` event | − amount (indexer) | — |
| Load card (`POST /cards/load`) | operator signs `settle_card_spend(user, amount, ref)` | − amount (indexer, on `card_spend_settled`) | + amount (load worker, after the issuer funds the card) |
| Unload card (`POST /cards/unload`) | treasury signs `credit_refund(user, amount, ref)` | + amount (indexer, on `refund_credited`) | − amount (unload worker, after the issuer defunds the card) |
| Card spend (issuer webhook) | none | — | − amount |
| Merchant refund / reversal (issuer webhook) | none | — | + amount |
| Subscription charge, payroll funding and disbursement | user / keeper signs | informational ledger row only | — |

The contract functions keep their deployed names: `settle_card_spend` means "move USDC from the user's vault to the treasury when loading the card" and `credit_refund` means "move USDC back when unloading". Renaming them (`load_card` / `unload_card`) is a backlog item for a future contract upgrade.

---

## 2. Deployed smart contracts

Source: `RL-smart-contracts` (branch `stellar-migration`), record `deployments/testnet.json`, commit `2136695`.

| Contract | Testnet id | Purpose |
|---|---|---|
| vault | `CBGARSQ7BY4345DNX76LWT4VXEHRRFJMNW46SCX7DRHBILL5V6RJN6KR` | Custody for card funding: `deposit`, `withdraw`, `settle_card_spend` (operator), `credit_refund` (treasury) |
| subscriptions | `CDWMLKAUMXHLSBOKKCK5A4ECUP2VIIHXAL7MVQ5TEFLE3QUXZRMDC3PC` | Non-custodial allowance-based subscriptions: merchants, plans, `subscribe`, `charge`, `charge_batch` |
| payroll | `CB76PQ2MTILAQJAHLMTRHYDODX7H73YUCTVVKYO46ME3MK6WUTELDGYU` | Employer escrow and schedules: `fund`, `create_schedules`, `disburse`, `disburse_batch` |
| USDC SAC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | Circle testnet USDC (issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) |

Role accounts (public keys; secrets live in the operators' secret stores): admin `GCW4BX…YE6G`, operator `GASCJC…PNXN`, treasury `GDRCO5…B4T5`, keeper `GAL5BE…3WSQ`, fee recipient `GCW2OS…ZZIC`. Fee: 50 bps on subscriptions and payroll.

### 2.1 Events the backend consumes

Every event is emitted with the SDK's `#[contractevent]` macro: topic 0 is the event name (symbol), topic 1 the primary address, and the data is a map of the other fields.

| Contract | Event | Backend effect |
|---|---|---|
| vault | `deposit(user; amount)` | `Deposit` row, `walletBalance` +, `DEPOSIT` ledger row |
| vault | `withdraw(user; amount)` | `walletBalance` −, `WITHDRAWAL` row. Going negative raises `LedgerInvariantError` (never clamped) |
| vault | `card_spend_settled(user; amount, reference)` | matching `CardMovement` (LOAD) → `SETTLED`, `walletBalance` −, `CARD_LOAD` row; no match → `CARD_SPEND_SETTLED` row |
| vault | `refund_credited(user; amount, reference)` | matching `CardMovement` (UNLOAD) → `COMPLETED`, `walletBalance` +, `CARD_UNLOAD` row; no match → `REFUND` row |
| vault | `operator_set`, `treasury_set`, admin, pause, upgrade | logged |
| subscriptions | `plan_created`, `plan_active_set` | `SubscriptionPlan` upsert |
| subscriptions | `subscribed(subscriber; sub_id, plan_id, next_due)` | `Subscription` upsert (plan fetched with `get_plan` if unknown) |
| subscriptions | `charged(subscriber; sub_id, plan_id, merchant, amount, fee, next_due)` | status `ACTIVE`, `nextDueAt`, `lastChargedAt`; informational `SUBSCRIPTION_PAYMENT` row for Rubbi users |
| subscriptions | `charge_failed(subscriber; sub_id, plan_id, amount)` | status `PAST_DUE` |
| subscriptions | `charge_skipped(subscriber; sub_id, reason)` | logged only (`merchant_inactive` / `payout_unavailable`; nothing changed on-chain) |
| subscriptions | `subscription_paused`, `subscription_resumed(next_due)`, `subscription_cancelled` | status updates |
| payroll | `funded(employer; amount)` | informational `PAYROLL_FUNDED` row |
| payroll | `schedule_created(employer; schedule_id, recipient, amount, period, next_due)` | `PayrollSchedule` upsert; the **label is read with `get_schedule`** because the event does not carry it |
| payroll | `disbursed(employer; schedule_id, recipient, amount, fee, next_due)` | `nextDueAt`, `lastDisbursedAt`; informational `PAYROLL_DISBURSED` row for a Rubbi recipient |
| payroll | `disburse_failed(employer; schedule_id, amount, escrow, reason)` | logged (`insufficient_escrow` / `recipient_unpayable`; period stays owed) |
| payroll | `schedule_paused`, `schedule_resumed(next_due)`, `schedule_cancelled` | status updates |

---

## 3. Architecture

```
┌──────────────┐     Stellar Wallets Kit      ┌────────────────────────────┐
│  Next.js     │ ───── sign txs ────────────▶ │  Soroban contracts          │
│  frontend    │                              │  • vault                    │
│              │ ◀──── SEP-10 JWT ──────┐     │  • subscriptions            │
└──────┬───────┘                        │     │  • payroll                  │
       │ REST                           │     │  (asset: USDC via its SAC)  │
       ▼                                │     └──────────▲─────────────────┘
┌──────────────────────────────────────┴──┐             │ getEvents (cursor)
│  Backend (Bun/Fastify/Prisma/BullMQ)     │◀────────────┘
│  • SEP-10 auth                           │ ── keeper: charge_batch / disburse_batch
│  • event indexer → mirrors + ledgers     │ ── operator: settle_card_spend (card load)
│  • card load / unload workers            │ ── treasury: credit_refund (card unload)
│  • card issuer: MockCardIssuer | Sudo    │
└──────────────────────────────────────────┘
```

Backend-signed calls, and nothing else: `settle_card_spend` (operator), `credit_refund` (treasury, optional), `charge_batch` / `charge` / `disburse_batch` / `disburse` (keeper). Reads use simulation only.

---

## 4. Tech stack

| Layer | Technology |
|---|---|
| Runtime | Bun 1.4 (lockfile: `bun.lock` only) |
| Framework | Fastify v5 |
| Language | TypeScript (strict) |
| ORM | Prisma 6 (`prisma-client-js`) |
| Database | PostgreSQL 16 |
| Queues | BullMQ 5 on Redis 7 (ioredis) |
| Chain client | `@stellar/stellar-sdk` 17 (`rpc.Server`, `WebAuth`, XDR) |
| Card issuer | `MockCardIssuer` (default) or Sudo Africa |
| Auth | SEP-10 challenge/response + JWT session |
| Validation | Zod + Fastify JSON Schema |
| Logging | Pino |

---

## 5. Environment variables

See `.env.example`. Validated by Zod in `src/config/index.ts`; the process refuses to start on an invalid value.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV`, `PORT` | | `development` \| `test` \| `production`; default port 3000 |
| `DATABASE_URL`, `REDIS_URL` | yes | |
| `STELLAR_NETWORK` | | `testnet` (default) or `mainnet` |
| `STELLAR_RPC_URL` | yes | Soroban RPC; `http://` is allowed only for local nodes |
| `STELLAR_NETWORK_PASSPHRASE` | | defaults to the passphrase of `STELLAR_NETWORK` |
| `USDC_SAC_ID`, `VAULT_CONTRACT_ID`, `SUBSCRIPTIONS_CONTRACT_ID`, `PAYROLL_CONTRACT_ID` | yes | must be valid `C...` contract ids |
| `OPERATOR_SECRET`, `KEEPER_SECRET`, `SEP10_SIGNING_SECRET` | yes | valid `S...` seeds; the all-zero placeholder is rejected in production |
| `TREASURY_SECRET` | no | when unset, card unloads wait in `PENDING_TREASURY` for `scripts/process-pending-unloads.ts` |
| `HOME_DOMAIN`, `WEB_AUTH_DOMAIN` | yes | SEP-10 domains |
| `INDEXER_POLL_INTERVAL_MS` | | default 5000 |
| `INDEXER_START_LEDGER` | no | first run only; defaults to the latest ledger |
| `KEEPER_CRON` | | default `*/10 * * * *` |
| `KEEPER_HOLD_SECONDS` | | default 21600 (6 h): how long a payee without a usable trustline is left alone |
| `CARD_ISSUER` | | `mock` (default) or `sudo` |
| `SUDO_API_KEY`, `SUDO_WEBHOOK_SECRET` | with `sudo` | `SUDO_WEBHOOK_SECRET` is also required in production with the mock issuer |
| `SUDO_BASE_URL`, `SUDO_DEFAULT_CUSTOMER_ID` | no | |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | yes | ≥ 32 chars; the example placeholder is rejected in production |
| `CORS_ORIGINS` | | comma-separated absolute URLs of the browser origins allowed by CORS (exact match, no wildcard, no credentials); default `http://localhost:3000` |

Stellar addresses are case-sensitive and are never normalised. `G...` ids are validated with `StrKey.isValidEd25519PublicKey`, `C...` ids with `StrKey.isValidContract`.

---

## 6. Project structure

```
src/
  app.ts                      Fastify app: plugins, routes, workers, indexer
  server.ts                   entrypoint
  config/index.ts             Zod-validated env
  lib/
    stellar/
      client.ts               rpc.Server, contract ids, operator/keeper/treasury keypairs
      address.ts              StrKey checks
      amount.ts               stroops <-> Decimal(7), formatUsdc
      errors.ts               contract error code tables (from errors.rs)
      events.ts               event decoding (RPC and XDR) + typed RubbiEvent
      tx.ts                   simulate / assemble / sign / send / poll, arg builders
      contracts.ts            simulated reads: get_schedule, get_plan, get_subscription, balance
      vault.ts                settle_card_spend / credit_refund wrappers (VaultClient)
      keeper-chain.ts         charge(_batch) / disburse(_batch) wrappers
      handlers.ts             event -> database effects
      indexer.ts              cursor loop, exactly-once, retention gaps
    card-issuer/              ICardIssuer, mock.adapter, sudo.adapter, factory
    keeper-holds.ts           Redis holds for unpayable payees
    queue.ts                  BullMQ queues (card-load, card-unload, keeper)
  modules/
    auth/                     SEP-10 challenge + token
    users/                    me, username (creates the card)
    cards/                    card, freeze/unfreeze, number, load, unload, movements
    deposits/ transactions/   ledgers
    subscriptions/ payroll/   read-only mirrors
    dashboard/ stellar/       stats, public config
    webhooks/                 issuer webhook (cardBalance only)
    dev/                      POST /dev/mock-card-spend (mock issuer, non-production)
  workers/
    card-movement.processor.ts / .worker.ts   load & unload state machines
    keeper.processor.ts / .worker.ts          keeper runs
scripts/process-pending-unloads.ts            treasury-side completion of unloads
prisma/schema.prisma, prisma/migrations/      20260411 init, 20261027 stellar
tests/                                        bun test (fakes/prisma.ts, db/ needs Postgres)
```

---

## 7. Database schema

Money columns are `Decimal(20,7)`. BigInt columns hold on-chain `u64` ids.

| Model | Purpose | Key fields |
|---|---|---|
| `User` | one per Stellar account | `stellarAddress` (unique, verbatim), `username` (unique, once), `walletBalance`, `cardBalance` |
| `Card` | one per user | `issuer` (`MOCK` \| `SUDO`), `issuerId`, `last4`, expiry, `status` |
| `Deposit` | vault `deposit` events | `txHash`, `eventId` (unique), `amountRaw` (stroops), `amount`, `ledger` |
| `Transaction` | ledger rows | `account` (`WALLET` \| `CARD`), `type`, signed `amount`, `balanceAfter`, `metadata` (`informational: true` for on-chain-only money) |
| `CardMovement` | load/unload state machine | `direction`, `amount`, `reference` (unique, sha256 of id), `status`, `txHash`, `failureReason`, `compensatesId` |
| `SubscriptionPlan`, `Subscription` | mirrors | `onChainSubId` (unique), `subscriber`, `status` (`ACTIVE` \| `PAUSED` \| `PAST_DUE` \| `CANCELLED`), `nextDueAt` |
| `PayrollSchedule` | mirror | `onChainId` (unique), `employer`, `employerUserId`, `recipient`, `label`, `status`, `nextDueAt` |
| `ChainCursor` | indexer position (`id = "stellar"`) | `cursor`, `lastLedger` |
| `ProcessedEvent` | exactly-once | `eventId` (pk), `contractId`, `type`, `ledger`, `txHash` |
| `ChainGap` | ledgers skipped after a retention gap | `fromLedger`, `toLedger`, `reason`, `resolvedAt` |

`TransactionType`: `DEPOSIT`, `WITHDRAWAL`, `CARD_LOAD`, `CARD_UNLOAD`, `CARD_SPEND_SETTLED`, `SPEND`, `REFUND`, `SUBSCRIPTION_PAYMENT`, `PAYROLL_FUNDED`, `PAYROLL_DISBURSED`.

The `20261027000000_stellar` migration empties the legacy tables first: EVM addresses and RUBBI amounts have no Stellar meaning.

---

## 8. Stellar client layer

- **`client.ts`** builds one `rpc.Server` from `STELLAR_RPC_URL` and derives the operator, keeper and treasury keypairs lazily from their seeds. Secrets never leave the process and are never logged.
- **`amount.ts`** converts with string arithmetic only (`stroopsToDecimal`, `decimalToStroops`, `formatUsdc`). No floating point money anywhere.
- **`events.ts`** decodes `getEvents` entries and `ContractEvent` XDR into `DecodedEvent { name, topics, data }` and validates each known event into a typed `RubbiEvent`. Unknown shapes raise `EventDecodeError`; the indexer logs and skips them.
- **`tx.ts`** is the one transaction helper: build → `simulateTransaction` → `assembleTransaction` → sign → `sendTransaction` → `pollTransaction`. `SimulationFailed` carries the contract error name (from `errors.ts`), `TransactionRetryable` marks `TRY_AGAIN_LATER` / `NOT_FOUND`, `TransactionFailed` everything else. `simulateRead` serves reads without an account lookup.
- **`contracts.ts`** wraps the getters the indexer needs (`get_schedule`, `get_plan`, `get_subscription`, `balance`).
- **`vault.ts`** and **`keeper-chain.ts`** wrap the backend-signed calls and map `DuplicateReference` to an idempotent "already done".

---

## 9. Event indexer

`src/lib/stellar/indexer.ts`, started from `app.ts` (not under `NODE_ENV=test`).

1. Reads `ChainCursor`. First run: `getEvents({ startLedger: INDEXER_START_LEDGER ?? latest })`; later runs: `getEvents({ cursor })`, filtered to the three contract ids, pages of 100, fetching again immediately while pages are full.
2. For each event: decode; events of other contracts are skipped; a known event's effect is prepared (including any on-chain read, such as `get_schedule` for the label) **before** a database transaction that inserts the `ProcessedEvent` row and applies the effect. The unique `eventId` makes a replayed event a no-op; a failing effect leaves no trace (tested against Postgres).
3. After each page the cursor and last ledger are saved.
4. **Retention gaps.** If the RPC rejects the saved cursor and `getHealth().oldestLedger` is beyond `lastLedger`, the indexer logs `INDEXER GAP` at error level, writes a `ChainGap` row (`lastLedger + 1 … oldestLedger − 1`) and resumes from `oldestLedger`. Backfill tooling for those rows is a Drips Wave backlog item.
5. A `withdraw` that would push `walletBalance` below zero raises `LedgerInvariantError` loudly and halts that event (it is retried on every poll until an operator investigates); it is never clamped.

---

## 10. Card load / unload pipeline

`src/workers/card-movement.processor.ts` (pure, tested) and `card-movement.worker.ts` (BullMQ).

```
LOAD    PENDING ──settle_card_spend (operator)──▶ SETTLED ──fund card (issuer)──▶ COMPLETED
                                                     │ issuer fails permanently
                                                     ▼
                                                 FAILED + compensating UNLOAD (skips the card step)
UNLOAD  PENDING ──defund card, cardBalance −──▶ SETTLED ──credit_refund (treasury)──▶ COMPLETED
                                                    └── no TREASURY_SECRET ──▶ PENDING_TREASURY
```

- `reference = sha256(movement id)` is the vault's idempotency key. The contract returns `DuplicateReference` for a replay, which the workers treat as "already done". A reference is never reused: the column is unique and spend and refund references are separate namespaces on-chain.
- `walletBalance` is **never** changed by the workers; the indexer changes it when `card_spend_settled` / `refund_credited` arrive. `cardBalance` changes with the issuer step, in the same database transaction as the `CARD_LOAD` / `CARD_UNLOAD` row.
- Issuer calls carry the reference so a retried call is applied once (`MockCardIssuer` enforces it; the Sudo behaviour is `TODO(verify)`).
- `POST /cards/load` rejects amounts above `walletBalance` minus loads in flight; `POST /cards/unload` rejects amounts above `cardBalance` minus unloads in flight. The chain remains the final authority: an on-chain `InsufficientBalance` marks the load `FAILED`.
- Jobs retry 6 times with exponential backoff. When a load's issuer funding fails after the settlement, `compensateFailedLoad` marks it `FAILED` and creates an `UNLOAD` with `compensatesId` that goes straight to `credit_refund`.
- Without `TREASURY_SECRET`, unloads stop at `PENDING_TREASURY`. An operator holding the treasury key runs `TREASURY_SECRET=S... bun run scripts/process-pending-unloads.ts` (`--dry-run` lists them) from a machine of their own; the API's `.env` never holds that key.

---

## 11. Authentication — SEP-10

- `GET /auth/challenge?account=G...` → `{ transaction, network_passphrase }`. Built with `WebAuth.buildChallengeTx` (sequence 0, 300 s window, `HOME_DOMAIN` manage-data op, `web_auth_domain` op), signed by `SEP10_SIGNING_SECRET`.
- `POST /auth/token { transaction }` → `readChallengeTx` (server signature, time bounds, home domain, web auth domain) + `verifyChallengeTxSigners` (the client's master key signed). Then the user row is upserted and a JWT with `sub = G...` is issued (`JWT_EXPIRES_IN`).
- Limits, documented in code: only the account's master key is accepted (no Horizon signer lookup, so multisig or a zero-weight master key fails); contract accounts (`C...`, passkey wallets) need SEP-45. Both are backlog items.
- `POST /users/username` sets the username once per address (L11) and creates the card.

---

## 12. API routes

Base path `/api/v1`. JWT = `Authorization: Bearer <token>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | liveness |
| GET | `/auth/challenge?account=` | — | SEP-10 challenge |
| POST | `/auth/token` | — | SEP-10 token |
| GET | `/users/me` | JWT | profile, both balances, card |
| POST | `/users/username` | JWT | set username once; creates the card |
| GET | `/cards/me` | JWT | card + balances |
| POST | `/cards/freeze`, `/cards/unfreeze` | JWT | issuer freeze/unfreeze |
| GET | `/cards/me/number` | JWT | PAN from the issuer (`null` for MOCK) |
| POST | `/cards/load` | JWT | queue a load (202 + movement) |
| POST | `/cards/unload` | JWT | queue an unload (202 + movement) |
| GET | `/cards/movements` | JWT | loads and unloads with status |
| GET | `/deposits`, `/deposits/:txHash` | JWT | vault deposits |
| GET | `/transactions?account=&page=&pageSize=` | JWT | ledger rows |
| GET | `/subscriptions/plans`, `/subscriptions/plans/:planId` | — | plan mirror |
| GET | `/subscriptions/me` | JWT | my subscriptions |
| GET | `/payroll/schedules`, `/payroll/schedules/incoming`, `/payroll/schedules/:scheduleId` | JWT | schedule mirror |
| GET | `/dashboard/stats` | JWT | balances, counts, recent rows |
| GET | `/stellar/config` | — | network and contract ids |
| POST | `/webhooks/card-issuer` | HMAC | issuer events |
| POST | `/dev/mock-card-spend` | — (dev + mock only) | simulate a spend through the real webhook path |

Swagger UI: `GET /docs`.

---

## 13. Card issuer abstraction

`ICardIssuer { name, createVirtualCard, fundCard(cardId, amount, reference), defundCard(cardId, amount, reference), freezeCard, unfreezeCard, getCardDetails }`.

- **`MockCardIssuer`** (`CARD_ISSUER=mock`, default): card id and last4 derived from a hash of the user id; no PAN or CVV exist; fund/defund idempotent by reference; balances in memory only. Every card is stored with `issuer = "MOCK"` so the frontend shows a MOCK badge.
- **`SudoCardIssuer`** (`CARD_ISSUER=sudo`): unchanged HTTP adapter. `defundCard` is `TODO(verify)` (the endpoint is not documented here) and throws until confirmed, so unloads fail before anything moves; whether `fundCard` accepts an idempotency key is also `TODO(verify)`.

---

## 14. Webhook handler

`POST /webhooks/card-issuer` verifies the HMAC-SHA256 of the raw body against `SUDO_WEBHOOK_SECRET` (`x-sudo-signature` or `x-signature`), deduplicates by event id in Redis (24 h), answers `authorization.request` from `cardBalance`, debits `cardBalance` for `card.charge` / `transaction.created` purchases, credits it for `refund` / `reversal`, and writes the `CARD` ledger row in the same transaction. It never touches the chain or `walletBalance`.

---

## 15. Workers and queues

| Queue | Worker | Job |
|---|---|---|
| `card-load-queue` | `startCardLoadWorker` | `processLoad(movementId)`; on final failure `compensateFailedLoad` |
| `card-unload-queue` | `startCardUnloadWorker` | `processUnload(movementId)` |
| `keeper-queue` | `startKeeperWorker` | `runKeeper()` on `KEEPER_CRON` (job scheduler `keeper`), concurrency 1 |

**Keeper algorithm** (`keeper.processor.ts`, replaces the old no-op subscription worker, L15):

1. Due items from the mirrors: subscriptions `ACTIVE` or `PAST_DUE` with `nextDueAt <= now`; schedules `ACTIVE` with `nextDueAt <= now`.
2. Items on hold (Redis `keeper:hold:<kind>:<id>`) are skipped.
3. Chunks of at most 25 → `charge_batch` / `disburse_batch` signed by the keeper. If a whole batch fails (simulation or submission), its items are retried one by one; an item that fails alone is logged at error level and counted.
4. Each `false` result is classified from the call's events: `charge_skipped` (`payout_unavailable`, `merchant_inactive`) and `disburse_failed` with `recipient_unpayable` → hold for `KEEPER_HOLD_SECONDS`; `charge_failed` (now PastDue) and `insufficient_escrow` → normal business outcome, logged; no event → not due on-chain (stale mirror).
5. The keeper never writes the mirrors; the indexer does when the events arrive.

---

## 16. Balance invariants

1. `walletBalance` and `cardBalance` can never go below 0. A `withdraw` that would do so raises `LedgerInvariantError`; a spend that would do so is rejected with 400.
2. Every change to either balance writes a `Transaction` row with `account`, the signed `amount` and `balanceAfter`, in the same database transaction.
3. `walletBalance` is written only by the indexer, only from confirmed chain events, each applied once (`ProcessedEvent`).
4. `cardBalance` is credited only after the issuer funded the card, and debited by spends, unloads and compensations.
5. Card money is never in the vault: loading settles on-chain before funding; unloading defunds before refunding.
6. All money is `Decimal(20,7)` or `bigint` stroops; JavaScript `number` is never used for amounts.

---

## 17. Error handling

| Scenario | Behaviour |
|---|---|
| Same chain event twice | `ProcessedEvent` unique violation → skipped |
| Event for an address that is not a user | processed with no balance effect (logged) |
| `walletBalance` would go negative | `LedgerInvariantError`, loud log, event not marked processed |
| RPC cursor older than retention | `INDEXER GAP` log + `ChainGap` row, resume from oldest ledger |
| `settle_card_spend` rejected (`InsufficientBalance`, `Paused`) | load `FAILED` with the error name, no card funding |
| `DuplicateReference` | treated as already done |
| Issuer funding fails after settlement | retries; final failure → `FAILED` + compensating unload |
| `credit_refund` rejected | unload stays `PENDING_TREASURY` with the reason for an operator |
| Batch simulation fails | per-item retry; persistent failures surfaced |
| Payee without a usable USDC trustline | item held for `KEEPER_HOLD_SECONDS` |
| Webhook HMAC invalid | 401 + log |
| Invalid env | process does not start |

---

## 18. Testing

- `bun test` runs the unit suites with the in-memory Prisma fake (`tests/fakes/prisma.ts`); Redis and BullMQ are mocked where imported.
- `tests/db/*.test.ts` run against a real Postgres when `TEST_DATABASE_URL` is set (migrations applied with `bunx prisma migrate deploy`); they cover exactly-once processing and transaction atomicity.
- `bun run typecheck` must be clean.
- CI (`.github/workflows/ci.yml`) runs both with Postgres and Redis service containers.

---

## 19. Operations

- Local stack: `POSTGRES_PORT=5435 REDIS_PORT=6380 docker compose -f docker-compose.dev.yml up -d db redis` (ports configurable), then `bunx prisma migrate deploy` and `bun run dev`.
- Secrets: never commit `.env`; the all-zero seeds in `.env.example` are development placeholders and are rejected in production.
- The treasury key is optional and best kept off the API host; use `scripts/process-pending-unloads.ts`.
- Monitoring hooks (keeper metrics, health endpoints, alerting on `INDEXER GAP` and `LedgerInvariantError`) are backlog items.

---

## 20. Backlog pointers (Drips Wave)

SEP-45 auth for contract accounts; multisig-aware SEP-10 (Horizon signer lookup); fee-bump sponsorship; Sudo adapter hardened with recorded fixtures (fund idempotency, defund endpoint); indexer gap backfill from `ChainGap`; keeper metrics and alerting; notifications on `charge_failed` / `disburse_failed`; rename `settle_card_spend` / `credit_refund` to `load_card` / `unload_card` in a contract upgrade.
