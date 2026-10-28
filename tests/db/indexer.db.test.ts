import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk"

import { OTHER_ADDRESS, TEST_ENV, USER_ADDRESS, makeLog, seedEnv } from "../helpers.js"
import { hasTestDatabase, makeTestPrisma, resetDatabase } from "./setup.js"

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const addr = (a: string) => new Address(a).toScVal()
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" })
const bytes32 = (hex: string) => nativeToScVal(Buffer.from(hex, "hex"), { type: "bytes" })

let seq = 0
function ev(name: string, topics: xdr.ScVal[], data: Array<[string, xdr.ScVal]>, ledger = 100) {
  seq++
  return {
    id: `${String(ledger).padStart(10, "0")}-${String(seq).padStart(10, "0")}`,
    type: "contract" as const,
    ledger,
    ledgerClosedAt: "2026-10-27T21:00:00Z",
    transactionIndex: 1,
    operationIndex: 0,
    txHash: seq.toString(16).padStart(64, "0"),
    contractId: new Contract(TEST_ENV.VAULT_CONTRACT_ID),
    topic: [sym(name), ...topics],
    value: xdr.ScVal.scvMap(data.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v }))),
  }
}

function makeRpc(pages: Array<{ events: any[]; cursor: string }>) {
  return {
    async getEvents() {
      const page = pages.shift() ?? { events: [], cursor: "end" }
      return { ...page, latestLedger: 500, oldestLedger: 1, latestLedgerCloseTime: "0", oldestLedgerCloseTime: "0" }
    },
    async getHealth() {
      return { latestLedger: 500, oldestLedger: 1 }
    },
    async getLatestLedger() {
      return { sequence: 500 }
    },
  }
}

const reads = {
  getSchedule: async () => {
    throw new Error("not used")
  },
  getPlan: async () => {
    throw new Error("not used")
  },
  getSubscription: async () => {
    throw new Error("not used")
  },
}

describe.skipIf(!hasTestDatabase)("indexer against Postgres", () => {
  const prisma = makeTestPrisma()

  beforeAll(async () => {
    seedEnv()
    await prisma.$connect()
  })

  beforeEach(async () => {
    await resetDatabase(prisma)
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function indexerWith(pages: Array<{ events: any[]; cursor: string }>) {
    const { Indexer } = await import("../../src/lib/stellar/indexer.js")
    return new Indexer({
      prisma,
      rpc: makeRpc(pages) as any,
      reads,
      log: makeLog() as any,
      contractIds: [TEST_ENV.VAULT_CONTRACT_ID],
      pollIntervalMs: 1000,
    })
  }

  test("the same deposit event twice produces one Deposit, one Transaction and one credit", async () => {
    const user = await prisma.user.create({ data: { stellarAddress: USER_ADDRESS } })
    const deposit = ev("deposit", [addr(USER_ADDRESS)], [["amount", i128(250_000_000n)]])

    const first = await indexerWith([{ events: [deposit], cursor: "c1" }])
    await first.runOnce()
    const second = await indexerWith([{ events: [deposit], cursor: "c2" }])
    const result = await second.runOnce()

    expect(result.skipped).toBe(1)
    const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(reloaded.walletBalance.toFixed()).toBe("25")
    expect(await prisma.deposit.count()).toBe(1)
    expect(await prisma.transaction.count()).toBe(1)
    expect(await prisma.processedEvent.count()).toBe(1)
  })

  test("the processed-event row and the effects are one transaction (a failing effect leaves no trace)", async () => {
    // No user row: the withdraw cannot be applied... so make one with a too-small balance,
    // which raises LedgerInvariantError inside the transaction.
    await prisma.user.create({ data: { stellarAddress: USER_ADDRESS, walletBalance: "1" } })
    const withdraw = ev("withdraw", [addr(USER_ADDRESS)], [["amount", i128(50_000_000n)]])
    const indexer = await indexerWith([{ events: [withdraw], cursor: "c1" }])

    await expect(indexer.runOnce()).rejects.toThrow(/walletBalance .* would become/)

    expect(await prisma.processedEvent.count()).toBe(0)
    expect(await prisma.transaction.count()).toBe(0)
    const user = await prisma.user.findUniqueOrThrow({ where: { stellarAddress: USER_ADDRESS } })
    expect(user.walletBalance.toFixed()).toBe("1")
    expect(await prisma.chainCursor.count()).toBe(0)
  })

  test("the cursor persists across runs and card settlement references are applied once", async () => {
    await prisma.user.create({ data: { stellarAddress: USER_ADDRESS, walletBalance: "40" } })
    const reference = "ab".repeat(32)
    const me = await prisma.user.findUniqueOrThrow({ where: { stellarAddress: USER_ADDRESS } })
    await prisma.cardMovement.create({
      data: { userId: me.id, direction: "LOAD", amount: "12", reference, status: "PENDING" },
    })
    const settled = ev("card_spend_settled", [addr(USER_ADDRESS)], [
      ["amount", i128(120_000_000n)],
      ["reference", bytes32(reference)],
    ])

    await (await indexerWith([{ events: [settled], cursor: "c-1" }])).runOnce()
    expect(await prisma.chainCursor.findUnique({ where: { id: "stellar" } })).toMatchObject({ cursor: "c-1" })

    await (await indexerWith([{ events: [settled], cursor: "c-2" }])).runOnce()
    expect(await prisma.chainCursor.findUnique({ where: { id: "stellar" } })).toMatchObject({ cursor: "c-2" })

    const user = await prisma.user.findUniqueOrThrow({ where: { stellarAddress: USER_ADDRESS } })
    expect(user.walletBalance.toFixed()).toBe("28")
    expect(await prisma.cardMovement.findUniqueOrThrow({ where: { reference } })).toMatchObject({ status: "SETTLED" })
    expect(await prisma.transaction.count()).toBe(1)
  })

  test("events for non-users are processed without touching balances", async () => {
    const stranger = ev("deposit", [addr(OTHER_ADDRESS)], [["amount", i128(1n)]])
    await (await indexerWith([{ events: [stranger], cursor: "c" }])).runOnce()
    expect(await prisma.processedEvent.count()).toBe(1)
    expect(await prisma.transaction.count()).toBe(0)
  })
})
