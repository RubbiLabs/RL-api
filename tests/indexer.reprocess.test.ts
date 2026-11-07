import { beforeAll, describe, expect, test } from "bun:test"
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { OTHER_ADDRESS, TEST_ENV, USER_ADDRESS, makeLog, seedEnv } from "./helpers.js"
import { reprocessDeadLetters } from "../scripts/indexer-reprocess.js"
import { serializeRaw } from "../src/lib/stellar/indexer.js"

beforeAll(seedEnv)

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const addr = (a: string) => new Address(a).toScVal()
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" })

function makeDecodedEvent(name: string, data: Record<string, unknown>, ledger = 100) {
  return {
    id: `ev-${ledger}-1`,
    contractId: TEST_ENV.VAULT_CONTRACT_ID,
    contract: "vault" as const,
    ledger,
    ledgerClosedAt: "2026-10-27T21:00:00Z",
    txHash: "0".repeat(64),
    name,
    topics: [USER_ADDRESS],
    data,
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

describe("indexer: reprocess dead-letter events", () => {
  test("reprocesses a repaired dead letter by id and applies effect", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("50") }])

    const raw = makeDecodedEvent("withdraw", {
      user: USER_ADDRESS,
      amount: 20_000_000n,
    })

    prisma.seed("deadLetterEvent", [
      {
        id: "dl-1",
        eventId: raw.id,
        contractId: raw.contractId,
        type: "vault.withdraw",
        ledger: raw.ledger,
        txHash: raw.txHash,
        raw: serializeRaw(raw),
        attempts: 5,
        lastError: "LedgerInvariantError",
        reprocessedAt: null,
      },
    ])

    const res = await reprocessDeadLetters({
      prisma,
      reads,
      id: raw.id,
      dryRun: false,
    })

    expect(res.succeeded).toBe(1)
    expect(res.failed).toBe(0)

    const updated = prisma.rows("deadLetterEvent")[0]!
    expect(updated.reprocessedAt).not.toBeNull()

    const user = prisma.rows("user")[0]!
    expect(user.walletBalance.toFixed()).toBe("48")
    expect(prisma.rows("transaction")).toHaveLength(1)
  })

  test("--all --dry-run inspects without applying effects or mutating database", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("50") }])

    const raw = makeDecodedEvent("withdraw", {
      user: USER_ADDRESS,
      amount: 10_000_000n,
    })

    prisma.seed("deadLetterEvent", [
      {
        id: "dl-2",
        eventId: raw.id,
        contractId: raw.contractId,
        type: "vault.withdraw",
        ledger: raw.ledger,
        txHash: raw.txHash,
        raw: serializeRaw(raw),
        attempts: 5,
        lastError: "Simulated failure",
        reprocessedAt: null,
      },
    ])

    const res = await reprocessDeadLetters({
      prisma,
      reads,
      all: true,
      dryRun: true,
    })

    expect(res.processed).toBe(1)
    expect(res.details[0]!.status).toBe("dry-run")

    const letter = prisma.rows("deadLetterEvent")[0]!
    expect(letter.reprocessedAt).toBeNull()

    const user = prisma.rows("user")[0]!
    expect(user.walletBalance.toFixed()).toBe("50")
    expect(prisma.rows("transaction")).toHaveLength(0)
  })

  test("failed reprocess increments attempts and records lastError", async () => {
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("1") }])

    const raw = makeDecodedEvent("withdraw", {
      user: USER_ADDRESS,
      amount: 20_000_000n,
    })

    prisma.seed("deadLetterEvent", [
      {
        id: "dl-3",
        eventId: raw.id,
        contractId: raw.contractId,
        type: "vault.withdraw",
        ledger: raw.ledger,
        txHash: raw.txHash,
        raw: serializeRaw(raw),
        attempts: 5,
        lastError: "Initial error",
        reprocessedAt: null,
      },
    ])

    const res = await reprocessDeadLetters({
      prisma,
      reads,
      id: "dl-3",
      dryRun: false,
    })

    expect(res.failed).toBe(1)
    const letter = prisma.rows("deadLetterEvent")[0]!
    expect(letter.reprocessedAt).toBeNull()
    expect(letter.attempts).toBe(6)
    expect(letter.lastError).toContain("LedgerInvariantError")
  })
})
