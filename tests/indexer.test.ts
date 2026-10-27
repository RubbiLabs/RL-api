import { beforeAll, describe, expect, test } from "bun:test"
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { OTHER_ADDRESS, TEST_ENV, USER_ADDRESS, makeLog, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const addr = (a: string) => new Address(a).toScVal()
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" })
const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" })
const u32 = (n: number) => nativeToScVal(n, { type: "u32" })
const str = (s: string) => nativeToScVal(s, { type: "string" })
const bytes32 = (hex: string) => nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" })

let seq = 0
function ev(contractId: string, name: string, topics: xdr.ScVal[], data: Array<[string, xdr.ScVal]>, ledger = 100) {
  seq++
  return {
    id: `${String(ledger).padStart(10, "0")}-${String(seq).padStart(10, "0")}`,
    type: "contract" as const,
    ledger,
    ledgerClosedAt: "2026-10-27T21:00:00Z",
    transactionIndex: 1,
    operationIndex: 0,
    txHash: seq.toString(16).padStart(64, "0"),
    contractId: new Contract(contractId),
    topic: [sym(name), ...topics],
    value: xdr.ScVal.scvMap(data.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v }))),
  }
}

const CONTRACTS = [TEST_ENV.VAULT_CONTRACT_ID, TEST_ENV.SUBSCRIPTIONS_CONTRACT_ID, TEST_ENV.PAYROLL_CONTRACT_ID]

function makeRpc(pages: Array<{ events: any[]; cursor: string; latestLedger?: number }>, health = { latestLedger: 500, oldestLedger: 1 }) {
  const requests: any[] = []
  let failNext: Error | null = null
  return {
    requests,
    failNextGetEvents(error: Error) {
      failNext = error
    },
    rpc: {
      async getEvents(request: any) {
        requests.push(request)
        if (failNext) {
          const error = failNext
          failNext = null
          throw error
        }
        const page = pages.shift() ?? { events: [], cursor: "end", latestLedger: health.latestLedger }
        return {
          events: page.events,
          cursor: page.cursor,
          latestLedger: page.latestLedger ?? health.latestLedger,
          oldestLedger: health.oldestLedger,
          latestLedgerCloseTime: "0",
          oldestLedgerCloseTime: "0",
        }
      },
      async getHealth() {
        return health
      },
      async getLatestLedger() {
        return { sequence: health.latestLedger }
      },
    },
  }
}

const reads = {
  getSchedule: async (id: bigint) => ({
    id,
    employer: OTHER_ADDRESS,
    recipient: USER_ADDRESS,
    amount: 1_500_000_000n,
    period: 2_592_000n,
    next_due: 1_764_192_000n,
    status: "Active" as const,
    label: "Design lead",
    created_at: 1_761_600_000n,
  }),
  getPlan: async (id: number) => ({
    id,
    merchant: OTHER_ADDRESS,
    name: "Fetched plan",
    amount: 5_000_000n,
    period: 2_592_000n,
    active: true,
  }),
  getSubscription: async () => {
    throw new Error("not used")
  },
}

async function makeIndexer(prisma: any, rpc: any, extra: Partial<Record<string, unknown>> = {}) {
  const { Indexer } = await import("../src/lib/stellar/indexer.js")
  return new Indexer({
    prisma,
    rpc,
    reads,
    log: makeLog() as any,
    contractIds: CONTRACTS,
    pollIntervalMs: 1_000,
    ...extra,
  })
}

describe("indexer: vault events and the wallet ledger", () => {
  test("a deposit credits walletBalance once, even when the event is delivered twice", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS }])
    const deposit = ev(TEST_ENV.VAULT_CONTRACT_ID, "deposit", [addr(USER_ADDRESS)], [["amount", i128(250_000_000n)]])
    const { rpc } = makeRpc([
      { events: [deposit], cursor: "c1" },
      { events: [deposit], cursor: "c2" }, // same event replayed by the RPC
    ])
    const indexer = await makeIndexer(prisma, rpc)

    const first = await indexer.runOnce()
    expect(first.applied).toBe(1)
    const second = await indexer.runOnce()
    expect(second.applied).toBe(0)
    expect(second.skipped).toBe(1)

    const user = prisma.rows("user")[0]!
    expect(user.walletBalance.toFixed()).toBe("25")
    expect(user.cardBalance.toFixed()).toBe("0")
    expect(prisma.rows("deposit")).toHaveLength(1)
    expect(prisma.rows("transaction")).toHaveLength(1)
    expect(prisma.rows("transaction")[0]).toMatchObject({ type: "DEPOSIT", account: "WALLET" })
    expect(prisma.rows("processedEvent")).toHaveLength(1)
  })

  test("deposit then withdraw touches only walletBalance; the card is never involved", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, cardBalance: new Prisma.Decimal("7") }])
    const { rpc } = makeRpc([
      {
        events: [
          ev(TEST_ENV.VAULT_CONTRACT_ID, "deposit", [addr(USER_ADDRESS)], [["amount", i128(100_000_000n)]]),
          ev(TEST_ENV.VAULT_CONTRACT_ID, "withdraw", [addr(USER_ADDRESS)], [["amount", i128(40_000_000n)]]),
        ],
        cursor: "c1",
      },
    ])
    const indexer = await makeIndexer(prisma, rpc)
    await indexer.runOnce()

    const user = prisma.rows("user")[0]!
    expect(user.walletBalance.toFixed()).toBe("6")
    expect(user.cardBalance.toFixed()).toBe("7")
    const types = prisma.rows("transaction").map((t) => [t.type, t.amount.toFixed(), t.balanceAfter.toFixed()])
    expect(types).toEqual([
      ["DEPOSIT", "10", "10"],
      ["WITHDRAWAL", "-4", "6"],
    ])
  })

  test("a withdraw that would make walletBalance negative raises a loud error and is never clamped", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("1") }])
    const { rpc } = makeRpc([
      { events: [ev(TEST_ENV.VAULT_CONTRACT_ID, "withdraw", [addr(USER_ADDRESS)], [["amount", i128(50_000_000n)]])], cursor: "c1" },
    ])
    const indexer = await makeIndexer(prisma, rpc)
    const { LedgerInvariantError } = await import("../src/lib/stellar/handlers.js")

    await expect(indexer.runOnce()).rejects.toThrow(LedgerInvariantError)
    expect(prisma.rows("chainCursor")).toHaveLength(0)
  })

  test("card_spend_settled debits walletBalance for the matching load and is idempotent", async () => {
    const prisma = makeFakePrisma()
    const reference = "ab".repeat(32)
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("30") }])
    prisma.seed("cardMovement", [
      { id: "m1", userId: "u1", direction: "LOAD", amount: new Prisma.Decimal("12"), reference, status: "PENDING" },
    ])
    const settled = ev(TEST_ENV.VAULT_CONTRACT_ID, "card_spend_settled", [addr(USER_ADDRESS)], [
      ["amount", i128(120_000_000n)],
      ["reference", bytes32(reference)],
    ])
    const { rpc } = makeRpc([{ events: [settled, settled], cursor: "c1" }])
    const indexer = await makeIndexer(prisma, rpc)
    const result = await indexer.runOnce()

    expect(result.applied).toBe(1)
    expect(result.skipped).toBe(1)
    expect(prisma.rows("user")[0]!.walletBalance.toFixed()).toBe("18")
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "SETTLED", txHash: settled.txHash })
    expect(prisma.rows("transaction")).toHaveLength(1)
    expect(prisma.rows("transaction")[0]).toMatchObject({ type: "CARD_LOAD", account: "WALLET" })
    expect(prisma.rows("transaction")[0]!.amount.toFixed()).toBe("-12")
  })

  test("refund_credited credits walletBalance for the matching unload and is idempotent", async () => {
    const prisma = makeFakePrisma()
    const reference = "cd".repeat(32)
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("1") }])
    prisma.seed("cardMovement", [
      { id: "m2", userId: "u1", direction: "UNLOAD", amount: new Prisma.Decimal("5"), reference, status: "PENDING_TREASURY" },
    ])
    const refunded = ev(TEST_ENV.VAULT_CONTRACT_ID, "refund_credited", [addr(USER_ADDRESS)], [
      ["amount", i128(50_000_000n)],
      ["reference", bytes32(reference)],
    ])
    const { rpc } = makeRpc([{ events: [refunded] , cursor: "c1" }, { events: [refunded], cursor: "c2" }])
    const indexer = await makeIndexer(prisma, rpc)
    await indexer.runOnce()
    await indexer.runOnce()

    expect(prisma.rows("user")[0]!.walletBalance.toFixed()).toBe("6")
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "COMPLETED" })
    expect(prisma.rows("transaction")).toHaveLength(1)
    expect(prisma.rows("transaction")[0]).toMatchObject({ type: "CARD_UNLOAD" })
  })

  test("a settlement without a matching load is still recorded, as CARD_SPEND_SETTLED", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("30") }])
    const { rpc } = makeRpc([
      {
        events: [
          ev(TEST_ENV.VAULT_CONTRACT_ID, "card_spend_settled", [addr(USER_ADDRESS)], [
            ["amount", i128(10_000_000n)],
            ["reference", bytes32("ef".repeat(32))],
          ]),
        ],
        cursor: "c1",
      },
    ])
    const indexer = await makeIndexer(prisma, rpc)
    await indexer.runOnce()
    expect(prisma.rows("user")[0]!.walletBalance.toFixed()).toBe("29")
    expect(prisma.rows("transaction")[0]).toMatchObject({ type: "CARD_SPEND_SETTLED" })
  })

  test("events for addresses that are not users are marked processed without effects", async () => {
    const prisma = makeFakePrisma()
    const { rpc } = makeRpc([
      { events: [ev(TEST_ENV.VAULT_CONTRACT_ID, "deposit", [addr(OTHER_ADDRESS)], [["amount", i128(1n)]])], cursor: "c1" },
    ])
    const indexer = await makeIndexer(prisma, rpc)
    const result = await indexer.runOnce()
    expect(result.applied).toBe(1)
    expect(prisma.rows("transaction")).toHaveLength(0)
    expect(prisma.rows("processedEvent")).toHaveLength(1)
  })
})

describe("indexer: cursor, paging and retention gaps", () => {
  test("starts from the latest ledger when there is no saved cursor and persists the cursor", async () => {
    const prisma = makeFakePrisma()
    const { rpc, requests } = makeRpc([{ events: [], cursor: "c-500", latestLedger: 500 }])
    const indexer = await makeIndexer(prisma, rpc)
    await indexer.runOnce()

    expect(requests[0]).toMatchObject({ startLedger: 500, limit: 100 })
    expect(requests[0].cursor).toBeUndefined()
    expect(prisma.rows("chainCursor")[0]).toMatchObject({ id: "stellar", cursor: "c-500", lastLedger: 500 })
  })

  test("honours INDEXER_START_LEDGER on the first run", async () => {
    const prisma = makeFakePrisma()
    const { rpc, requests } = makeRpc([{ events: [], cursor: "c" }])
    const indexer = await makeIndexer(prisma, rpc, { startLedger: 42 })
    await indexer.runOnce()
    expect(requests[0]).toMatchObject({ startLedger: 42 })
  })

  test("resumes from the saved cursor and advances it after each page", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("chainCursor", [{ id: "stellar", cursor: "saved", lastLedger: 10 }])
    const { rpc, requests } = makeRpc([
      { events: [ev(TEST_ENV.VAULT_CONTRACT_ID, "paused", [], [], 12)], cursor: "c-12" },
    ])
    const indexer = await makeIndexer(prisma, rpc)
    await indexer.runOnce()

    expect(requests[0]).toMatchObject({ cursor: "saved" })
    expect(requests[0].startLedger).toBeUndefined()
    expect(prisma.rows("chainCursor")[0]).toMatchObject({ cursor: "c-12", lastLedger: 12 })
  })

  test("keeps fetching while pages are full", async () => {
    const prisma = makeFakePrisma()
    const full = Array.from({ length: 100 }, (_, i) => ev(TEST_ENV.VAULT_CONTRACT_ID, "paused", [], [], 200 + i))
    const { rpc, requests } = makeRpc([
      { events: full, cursor: "c-full" },
      { events: [ev(TEST_ENV.VAULT_CONTRACT_ID, "unpaused", [], [], 300)], cursor: "c-300" },
    ])
    const indexer = await makeIndexer(prisma, rpc)
    const result = await indexer.runOnce()

    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ cursor: "c-full" })
    expect(result.fetched).toBe(101)
    expect(prisma.rows("chainCursor")[0]).toMatchObject({ cursor: "c-300", lastLedger: 300 })
  })

  test("records a gap, logs loudly and resumes from the oldest ledger when the cursor fell out of retention", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("chainCursor", [{ id: "stellar", cursor: "stale", lastLedger: 10 }])
    const errors: string[] = []
    const log = { ...makeLog(), error: (_o: unknown, msg: string) => errors.push(msg) }
    const { rpc, requests, failNextGetEvents } = makeRpc(
      [{ events: [ev(TEST_ENV.VAULT_CONTRACT_ID, "paused", [], [], 400)], cursor: "c-400" }],
      { latestLedger: 500, oldestLedger: 380 },
    )
    failNextGetEvents(new Error("startLedger must be within the ledger range: 380 - 500"))
    const indexer = await makeIndexer(prisma, rpc, { log })
    await indexer.runOnce()

    expect(requests[1]).toMatchObject({ startLedger: 380 })
    expect(prisma.rows("chainGap")[0]).toMatchObject({ fromLedger: 11, toLedger: 379 })
    expect(errors.some((m) => m.includes("INDEXER GAP"))).toBe(true)
    expect(prisma.rows("chainCursor")[0]).toMatchObject({ cursor: "c-400", lastLedger: 400 })
  })

  test("other RPC errors propagate and leave the cursor untouched", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("chainCursor", [{ id: "stellar", cursor: "saved", lastLedger: 490 }])
    const { rpc, failNextGetEvents } = makeRpc([], { latestLedger: 500, oldestLedger: 380 })
    failNextGetEvents(new Error("connect ECONNREFUSED"))
    const indexer = await makeIndexer(prisma, rpc)
    await expect(indexer.runOnce()).rejects.toThrow("ECONNREFUSED")
    expect(prisma.rows("chainCursor")[0]).toMatchObject({ cursor: "saved" })
    expect(prisma.rows("chainGap")).toHaveLength(0)
  })
})

describe("indexer: subscription and payroll mirrors", () => {
  test("plan_created, subscribed, charged, charge_failed and lifecycle events update the mirrors", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS }])
    const subs = TEST_ENV.SUBSCRIPTIONS_CONTRACT_ID
    const { rpc } = makeRpc([
      {
        events: [
          ev(subs, "plan_created", [addr(OTHER_ADDRESS)], [
            ["plan_id", u32(1)],
            ["name", str("Pro")],
            ["amount", i128(99_000_000n)],
            ["period", u64(2_592_000n)],
          ]),
          ev(subs, "subscribed", [addr(USER_ADDRESS)], [
            ["sub_id", u64(7n)],
            ["plan_id", u32(1)],
            ["next_due", u64(1_764_192_000n)],
          ]),
          ev(subs, "charged", [addr(USER_ADDRESS)], [
            ["sub_id", u64(7n)],
            ["plan_id", u32(1)],
            ["merchant", addr(OTHER_ADDRESS)],
            ["amount", i128(99_000_000n)],
            ["fee", i128(495_000n)],
            ["next_due", u64(1_766_784_000n)],
          ]),
          ev(subs, "charge_failed", [addr(USER_ADDRESS)], [
            ["sub_id", u64(7n)],
            ["plan_id", u32(1)],
            ["amount", i128(99_000_000n)],
          ]),
        ],
        cursor: "c1",
      },
    ])
    const indexer = await makeIndexer(prisma, rpc)
    await indexer.runOnce()

    expect(prisma.rows("subscriptionPlan")[0]).toMatchObject({ id: 1, merchant: OTHER_ADDRESS, name: "Pro", period: 2_592_000 })
    expect(prisma.rows("subscriptionPlan")[0]!.amount.toFixed()).toBe("9.9")
    const sub = prisma.rows("subscription")[0]!
    expect(sub).toMatchObject({ onChainSubId: 7n, subscriber: USER_ADDRESS, userId: "u1", planId: 1, status: "PAST_DUE" })
    expect(sub.nextDueAt.toISOString()).toBe(new Date(1_766_784_000 * 1000).toISOString())
    const info = prisma.rows("transaction")
    expect(info).toHaveLength(1)
    expect(info[0]).toMatchObject({ type: "SUBSCRIPTION_PAYMENT", account: "WALLET" })
    expect(info[0]!.metadata.informational).toBe(true)
    expect(prisma.rows("user")[0]!.walletBalance.toFixed()).toBe("0")

    const { rpc: rpc2 } = makeRpc([
      {
        events: [
          ev(subs, "subscription_paused", [addr(USER_ADDRESS)], [["sub_id", u64(7n)]]),
          ev(subs, "subscription_resumed", [addr(USER_ADDRESS)], [["sub_id", u64(7n)], ["next_due", u64(1_770_000_000n)]]),
          ev(subs, "subscription_cancelled", [addr(USER_ADDRESS)], [["sub_id", u64(7n)]]),
          ev(subs, "plan_active_set", [addr(OTHER_ADDRESS)], [["plan_id", u32(1)], ["active", nativeToScVal(false)]]),
        ],
        cursor: "c2",
      },
    ])
    await (await makeIndexer(prisma, rpc2)).runOnce()
    expect(prisma.rows("subscription")[0]).toMatchObject({ status: "CANCELLED" })
    expect(prisma.rows("subscriptionPlan")[0]).toMatchObject({ active: false })
  })

  test("subscribed to a plan unknown to the mirror fetches the plan on-chain first", async () => {
    const prisma = makeFakePrisma()
    const { rpc } = makeRpc([
      {
        events: [
          ev(TEST_ENV.SUBSCRIPTIONS_CONTRACT_ID, "subscribed", [addr(OTHER_ADDRESS)], [
            ["sub_id", u64(9n)],
            ["plan_id", u32(3)],
            ["next_due", u64(1_764_192_000n)],
          ]),
        ],
        cursor: "c1",
      },
    ])
    await (await makeIndexer(prisma, rpc)).runOnce()
    expect(prisma.rows("subscriptionPlan")[0]).toMatchObject({ id: 3, name: "Fetched plan" })
    expect(prisma.rows("subscription")[0]).toMatchObject({ onChainSubId: 9n, userId: null })
  })

  test("schedule_created reads the label with get_schedule; disbursed and lifecycle update the mirror", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [
      { id: "emp", stellarAddress: OTHER_ADDRESS },
      { id: "staff", stellarAddress: USER_ADDRESS },
    ])
    const payroll = TEST_ENV.PAYROLL_CONTRACT_ID
    const { rpc } = makeRpc([
      {
        events: [
          ev(payroll, "funded", [addr(OTHER_ADDRESS)], [["amount", i128(10_000_000_000n)]]),
          ev(payroll, "schedule_created", [addr(OTHER_ADDRESS)], [
            ["schedule_id", u64(5n)],
            ["recipient", addr(USER_ADDRESS)],
            ["amount", i128(1_500_000_000n)],
            ["period", u64(2_592_000n)],
            ["next_due", u64(1_764_192_000n)],
          ]),
          ev(payroll, "disbursed", [addr(OTHER_ADDRESS)], [
            ["schedule_id", u64(5n)],
            ["recipient", addr(USER_ADDRESS)],
            ["amount", i128(1_500_000_000n)],
            ["fee", i128(7_500_000n)],
            ["next_due", u64(1_766_784_000n)],
          ]),
          ev(payroll, "disburse_failed", [addr(OTHER_ADDRESS)], [
            ["schedule_id", u64(5n)],
            ["amount", i128(1_500_000_000n)],
            ["escrow", i128(0n)],
            ["reason", sym("insufficient_escrow")],
          ]),
          ev(payroll, "schedule_paused", [addr(OTHER_ADDRESS)], [["schedule_id", u64(5n)]]),
        ],
        cursor: "c1",
      },
    ])
    await (await makeIndexer(prisma, rpc)).runOnce()

    const schedule = prisma.rows("payrollSchedule")[0]!
    expect(schedule).toMatchObject({
      onChainId: 5n,
      employer: OTHER_ADDRESS,
      employerUserId: "emp",
      recipient: USER_ADDRESS,
      label: "Design lead",
      status: "PAUSED",
    })
    expect(schedule.amount.toFixed()).toBe("150")
    expect(schedule.nextDueAt.toISOString()).toBe(new Date(1_766_784_000 * 1000).toISOString())
    const rows = prisma.rows("transaction")
    expect(rows.map((r) => [r.userId, r.type])).toEqual([
      ["emp", "PAYROLL_FUNDED"],
      ["staff", "PAYROLL_DISBURSED"],
    ])
    for (const u of prisma.rows("user")) expect(u.walletBalance.toFixed()).toBe("0")
  })
})
