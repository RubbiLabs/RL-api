import { beforeAll, describe, expect, test } from "bun:test"
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { OTHER_ADDRESS, TEST_ENV, USER_ADDRESS, makeLog, seedEnv } from "./helpers.js"
import { backfillGaps } from "../scripts/backfill-gaps.js"

beforeAll(seedEnv)

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const addr = (a: string) => new Address(a).toScVal()
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" })

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

const reads = {
  getSchedule: async () => { throw new Error("not used") },
  getPlan: async () => { throw new Error("not used") },
  getSubscription: async () => { throw new Error("not used") },
}

describe("indexer: chain gap backfill tooling", () => {
  test("backfills a simulated chain gap and reconciles walletBalance", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("0") }])

    // Gap from ledger 100 to 110
    prisma.seed("chainGap", [
      {
        id: "gap-1",
        fromLedger: 100,
        toLedger: 110,
        reason: "oldestLedger is 111 but saved is 99",
        resolvedAt: null,
      },
    ])

    // Events within the gap
    const dep1 = ev(TEST_ENV.VAULT_CONTRACT_ID, "deposit", [addr(USER_ADDRESS)], [["amount", i128(100_000_000n)]], 102)
    const dep2 = ev(TEST_ENV.VAULT_CONTRACT_ID, "deposit", [addr(USER_ADDRESS)], [["amount", i128(50_000_000n)]], 108)

    const rpc = {
      async getEvents(request: any) {
        return {
          events: [dep1, dep2],
          cursor: "c-gap",
          latestLedger: 120,
          oldestLedger: 1,
          latestLedgerCloseTime: "0",
          oldestLedgerCloseTime: "0",
        }
      },
      async getHealth() {
        return { latestLedger: 120, oldestLedger: 1 }
      },
      async getLatestLedger() {
        return { sequence: 120 }
      },
    }

    const result = await backfillGaps({
      prisma,
      rpc: rpc as any,
      reads,
      contractIds: [TEST_ENV.VAULT_CONTRACT_ID, TEST_ENV.SUBSCRIPTIONS_CONTRACT_ID, TEST_ENV.PAYROLL_CONTRACT_ID],
      dryRun: false,
    })

    expect(result.gapsProcessed).toBe(1)
    expect(result.eventsApplied).toBe(2)
    expect(result.gapsResolved).toEqual(["gap-1"])

    // Verify database state: user walletBalance = 15 XLM (10 + 5)
    const user = prisma.rows("user")[0]!
    expect(user.walletBalance.toFixed()).toBe("15")
    expect(prisma.rows("deposit")).toHaveLength(2)
    expect(prisma.rows("transaction")).toHaveLength(2)
    expect(prisma.rows("processedEvent")).toHaveLength(2)

    // Verify gap is resolved
    const gap = prisma.rows("chainGap")[0]!
    expect(gap.resolvedAt).not.toBeNull()
  })

  test("running backfill twice on resolved gaps applies nothing the second time", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("15") }])

    // Gap already resolved
    prisma.seed("chainGap", [
      {
        id: "gap-1",
        fromLedger: 100,
        toLedger: 110,
        reason: "resolved gap",
        resolvedAt: new Date(),
      },
    ])

    const rpc = {
      async getEvents() {
        throw new Error("RPC should not be called when all gaps are resolved")
      },
      async getHealth() { return { latestLedger: 120, oldestLedger: 1 } },
      async getLatestLedger() { return { sequence: 120 } },
    }

    const result = await backfillGaps({
      prisma,
      rpc: rpc as any,
      reads,
      dryRun: false,
    })

    expect(result.gapsProcessed).toBe(0)
    expect(result.eventsApplied).toBe(0)
  })

  test("--dry-run previews actions without modifying database or applying effects", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("0") }])

    prisma.seed("chainGap", [
      {
        id: "gap-dry",
        fromLedger: 100,
        toLedger: 105,
        reason: "gap",
        resolvedAt: null,
      },
    ])

    const dep = ev(TEST_ENV.VAULT_CONTRACT_ID, "deposit", [addr(USER_ADDRESS)], [["amount", i128(200_000_000n)]], 103)
    const rpc = {
      async getEvents() {
        return {
          events: [dep],
          cursor: "c-dry",
          latestLedger: 120,
          oldestLedger: 1,
          latestLedgerCloseTime: "0",
          oldestLedgerCloseTime: "0",
        }
      },
      async getHealth() { return { latestLedger: 120, oldestLedger: 1 } },
      async getLatestLedger() { return { sequence: 120 } },
    }

    const result = await backfillGaps({
      prisma,
      rpc: rpc as any,
      reads,
      contractIds: [TEST_ENV.VAULT_CONTRACT_ID],
      dryRun: true,
    })

    expect(result.gapsProcessed).toBe(1)
    expect(result.eventsFetched).toBe(1)
    expect(result.eventsApplied).toBe(0)

    // User balance remains 0
    const user = prisma.rows("user")[0]!
    expect(user.walletBalance.toFixed()).toBe("0")
    expect(prisma.rows("processedEvent")).toHaveLength(0)

    // Gap remains unresolved
    const gap = prisma.rows("chainGap")[0]!
    expect(gap.resolvedAt).toBeNull()
  })
})
