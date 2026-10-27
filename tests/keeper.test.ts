import { beforeAll, describe, expect, test } from "bun:test"

import { makeFakePrisma } from "./fakes/prisma.js"
import { OTHER_ADDRESS, USER_ADDRESS, makeLog, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

const NOW = new Date("2026-10-27T22:00:00Z")
const past = new Date(NOW.getTime() - 60_000)
const future = new Date(NOW.getTime() + 60_000)

type Outcome = { results: boolean[]; events?: any[] }

function makeChain(opts: {
  chargeBatch?: (ids: bigint[]) => Outcome | Error
  charge?: (id: bigint) => Outcome | Error
  disburseBatch?: (ids: bigint[]) => Outcome | Error
  disburse?: (id: bigint) => Outcome | Error
} = {}) {
  const calls: Array<{ method: string; ids: bigint[] }> = []
  const run = (method: string, ids: bigint[], fn?: (x: any) => Outcome | Error, arg?: any) => {
    calls.push({ method, ids })
    const out = fn ? fn(arg) : { results: ids.map(() => true) }
    if (out instanceof Error) throw out
    return { hash: `${method}-${calls.length}`, results: out.results, events: out.events ?? [] }
  }
  return {
    calls,
    chain: {
      chargeBatch: async (ids: bigint[]) => run("charge_batch", ids, opts.chargeBatch, ids),
      charge: async (id: bigint) => run("charge", [id], opts.charge, id),
      disburseBatch: async (ids: bigint[]) => run("disburse_batch", ids, opts.disburseBatch, ids),
      disburse: async (id: bigint) => run("disburse", [id], opts.disburse, id),
    },
  }
}

function seedSubs(prisma: any, ids: number[], extra: Record<string, unknown> = {}) {
  prisma.seed(
    "subscription",
    ids.map((id) => ({ onChainSubId: BigInt(id), subscriber: USER_ADDRESS, planId: 1, status: "ACTIVE", nextDueAt: past, ...extra })),
  )
}

function seedSchedules(prisma: any, ids: number[], extra: Record<string, unknown> = {}) {
  prisma.seed(
    "payrollSchedule",
    ids.map((id) => ({ onChainId: BigInt(id), employer: OTHER_ADDRESS, recipient: USER_ADDRESS, amount: 1, period: 86400, label: "x", status: "ACTIVE", nextDueAt: past, ...extra })),
  )
}

async function run(prisma: any, chain: any, holds?: any) {
  const { runKeeper } = await import("../src/workers/keeper.processor.js")
  const { makeMemoryHolds } = await import("../src/lib/keeper-holds.js")
  const h = holds ?? makeMemoryHolds()
  const result = await runKeeper({ prisma, chain, holds: h, log: makeLog() as any, holdSeconds: 3600, now: () => NOW })
  return { result, holds: h }
}

describe("keeper: selection", () => {
  test("submits only due, active or past-due subscriptions and due, active schedules", async () => {
    const prisma = makeFakePrisma()
    seedSubs(prisma, [1, 2])
    seedSubs(prisma, [3], { status: "PAST_DUE" })
    seedSubs(prisma, [4], { status: "PAUSED" })
    seedSubs(prisma, [5], { status: "CANCELLED" })
    seedSubs(prisma, [6], { nextDueAt: future })
    seedSchedules(prisma, [10, 11])
    seedSchedules(prisma, [12], { status: "PAUSED" })
    seedSchedules(prisma, [13], { nextDueAt: future })
    const { chain, calls } = makeChain()

    const { result } = await run(prisma, chain)

    expect(calls).toEqual([
      { method: "charge_batch", ids: [1n, 2n, 3n] },
      { method: "disburse_batch", ids: [10n, 11n] },
    ])
    expect(result.subscriptions).toMatchObject({ due: 3, submitted: 3, paid: 3 })
    expect(result.payroll).toMatchObject({ due: 2, submitted: 2, paid: 2 })
  })

  test("never writes the mirrors", async () => {
    const prisma = makeFakePrisma()
    seedSubs(prisma, [1])
    seedSchedules(prisma, [10])
    const { chain } = makeChain({ chargeBatch: () => ({ results: [false] }) })
    await run(prisma, chain)
    const writes = prisma.log.filter((l) => !["findMany", "findUnique", "findFirst", "count"].includes(l.op))
    expect(writes).toEqual([])
    expect(prisma.rows("subscription")[0]).toMatchObject({ status: "ACTIVE", nextDueAt: past })
  })
})

describe("keeper: chunking and batch failure", () => {
  test("chunks into batches of at most 25", async () => {
    const prisma = makeFakePrisma()
    seedSubs(prisma, Array.from({ length: 60 }, (_, i) => i + 1))
    seedSchedules(prisma, Array.from({ length: 26 }, (_, i) => 100 + i))
    const { chain, calls } = makeChain()

    const { result } = await run(prisma, chain)

    const sizes = calls.map((c) => [c.method, c.ids.length])
    expect(sizes).toEqual([
      ["charge_batch", 25],
      ["charge_batch", 25],
      ["charge_batch", 10],
      ["disburse_batch", 25],
      ["disburse_batch", 1],
    ])
    expect(result.subscriptions.paid).toBe(60)
    expect(result.payroll.paid).toBe(26)
  })

  test("a failed batch is retried item by item; the item that keeps failing alone is surfaced", async () => {
    const prisma = makeFakePrisma()
    seedSubs(prisma, [1, 2, 3])
    const errors: string[] = []
    const log = { ...makeLog(), error: (_o: unknown, m: string) => errors.push(m) }
    const { chain, calls } = makeChain({
      chargeBatch: () => new Error("simulation failed: HostError Error(Contract, #13)"),
      charge: (id) => (id === 2n ? new Error("simulation failed again") : { results: [true] }),
    })
    const { runKeeper } = await import("../src/workers/keeper.processor.js")
    const { makeMemoryHolds } = await import("../src/lib/keeper-holds.js")

    const result = await runKeeper({ prisma, chain, holds: makeMemoryHolds(), log: log as any, holdSeconds: 10, now: () => NOW })

    expect(calls.map((c) => c.method)).toEqual(["charge_batch", "charge", "charge", "charge", "disburse_batch"].slice(0, 4))
    expect(result.subscriptions).toMatchObject({ submitted: 2, paid: 2, erroredAlone: 1, batchesRetriedItemByItem: 1 })
    expect(errors.some((m) => m.includes("fails even when submitted alone"))).toBe(true)
  })
})

describe("keeper: classification of false results", () => {
  test("payout_unavailable and recipient_unpayable put the item on hold; the next run skips it", async () => {
    const prisma = makeFakePrisma()
    seedSubs(prisma, [1, 2])
    seedSchedules(prisma, [10, 11])
    const { chain, calls } = makeChain({
      chargeBatch: () => ({
        results: [false, true],
        events: [{ contract: "subscriptions", name: "charge_skipped", subscriber: USER_ADDRESS, sub_id: 1n, reason: "payout_unavailable" }],
      }),
      disburseBatch: () => ({
        results: [true, false],
        events: [
          { contract: "payroll", name: "disbursed", employer: OTHER_ADDRESS, schedule_id: 10n, recipient: USER_ADDRESS, amount: 1n, fee: 0n, next_due: 1n },
          { contract: "payroll", name: "disburse_failed", employer: OTHER_ADDRESS, schedule_id: 11n, amount: 1n, escrow: 5n, reason: "recipient_unpayable" },
        ],
      }),
    })

    const { result, holds } = await run(prisma, chain)
    expect(result.subscriptions).toMatchObject({ paid: 1, newHolds: 1, businessFailures: 0 })
    expect(result.payroll).toMatchObject({ paid: 1, newHolds: 1, businessFailures: 0 })
    expect(await holds.isHeld("subscriptions", 1n)).toBe(true)
    expect(await holds.isHeld("payroll", 11n)).toBe(true)

    const { result: second } = await run(prisma, chain, holds)
    expect(second.subscriptions).toMatchObject({ due: 2, held: 1, submitted: 1 })
    expect(second.payroll).toMatchObject({ due: 2, held: 1, submitted: 1 })
    expect(calls.slice(2)).toEqual([
      { method: "charge_batch", ids: [2n] },
      { method: "disburse_batch", ids: [10n] },
    ])
  })

  test("PastDue (charge_failed) and insufficient_escrow are normal outcomes, not holds", async () => {
    const prisma = makeFakePrisma()
    seedSubs(prisma, [1])
    seedSchedules(prisma, [10])
    const { chain } = makeChain({
      chargeBatch: () => ({
        results: [false],
        events: [{ contract: "subscriptions", name: "charge_failed", subscriber: USER_ADDRESS, sub_id: 1n, plan_id: 1, amount: 1n }],
      }),
      disburseBatch: () => ({
        results: [false],
        events: [{ contract: "payroll", name: "disburse_failed", employer: OTHER_ADDRESS, schedule_id: 10n, amount: 1n, escrow: 0n, reason: "insufficient_escrow" }],
      }),
    })
    const { result, holds } = await run(prisma, chain)
    expect(result.subscriptions).toMatchObject({ businessFailures: 1, newHolds: 0 })
    expect(result.payroll).toMatchObject({ businessFailures: 1, newHolds: 0 })
    expect(await holds.isHeld("subscriptions", 1n)).toBe(false)
    expect(await holds.isHeld("payroll", 10n)).toBe(false)
  })

  test("merchant_inactive is held too (nothing changes until the admin reactivates the merchant)", async () => {
    const prisma = makeFakePrisma()
    seedSubs(prisma, [1])
    const { chain } = makeChain({
      chargeBatch: () => ({
        results: [false],
        events: [{ contract: "subscriptions", name: "charge_skipped", subscriber: USER_ADDRESS, sub_id: 1n, reason: "merchant_inactive" }],
      }),
    })
    const { result, holds } = await run(prisma, chain)
    expect(result.subscriptions.newHolds).toBe(1)
    expect(await holds.isHeld("subscriptions", 1n)).toBe(true)
  })

  test("false without an event counts as not due (stale mirror)", async () => {
    const prisma = makeFakePrisma()
    seedSubs(prisma, [1])
    const { chain } = makeChain({ chargeBatch: () => ({ results: [false] }) })
    const { result } = await run(prisma, chain)
    expect(result.subscriptions).toMatchObject({ notDue: 1, newHolds: 0, businessFailures: 0 })
  })

  test("holds expire", async () => {
    const { makeRedisHolds, holdKey } = await import("../src/lib/keeper-holds.js")
    const store = new Map<string, number>()
    const redis = {
      set: async (key: string, _v: string, _m: "EX", seconds: number) => {
        store.set(key, seconds)
        return "OK"
      },
      exists: async (key: string) => (store.has(key) ? 1 : 0),
    }
    const holds = makeRedisHolds(redis)
    await holds.hold("payroll", 7n, 21_600)
    expect(store.get(holdKey("payroll", 7n))).toBe(21_600)
    expect(await holds.isHeld("payroll", 7n)).toBe(true)
    expect(await holds.isHeld("payroll", 8n)).toBe(false)
  })
})
