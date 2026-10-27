import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { USER_ADDRESS, makeLog, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

type Call = { method: string; user: string; amount: bigint; reference: string }

function makeVault(opts: { treasury?: boolean; settle?: () => Promise<any>; refund?: () => Promise<any> } = {}) {
  const calls: Call[] = []
  const settle = opts.settle ?? (async () => ({ outcome: "submitted", hash: "settlehash", ledger: 1 }))
  const refund = opts.refund ?? (async () => ({ outcome: "submitted", hash: "refundhash", ledger: 2 }))
  return {
    calls,
    vault: {
      settleCardSpend: async (input: Omit<Call, "method">) => {
        calls.push({ method: "settle_card_spend", ...input })
        return settle()
      },
      creditRefund:
        opts.treasury === false
          ? null
          : async (input: Omit<Call, "method">) => {
              calls.push({ method: "credit_refund", ...input })
              return refund()
            },
    },
  }
}

async function makeDeps(opts: { walletBalance?: string; cardBalance?: string; treasury?: boolean; settle?: () => Promise<any>; refund?: () => Promise<any> } = {}) {
  const { MockCardIssuer } = await import("../src/lib/card-issuer/mock.adapter.js")
  const prisma = makeFakePrisma()
  prisma.seed("user", [
    {
      id: "u1",
      stellarAddress: USER_ADDRESS,
      walletBalance: new Prisma.Decimal(opts.walletBalance ?? "100"),
      cardBalance: new Prisma.Decimal(opts.cardBalance ?? "0"),
    },
  ])
  const issuer = new MockCardIssuer()
  const card = await issuer.createVirtualCard({ userId: "u1", holderName: "u", currency: "USD", type: "virtual" })
  prisma.seed("card", [{ id: "card-1", userId: "u1", issuer: "MOCK", issuerId: card.id, last4: card.last4, expiryMonth: "12", expiryYear: "30" }])
  const { vault, calls } = makeVault(opts)
  const unloadsEnqueued: string[] = []
  const deps = {
    prisma: prisma as any,
    vault,
    cardIssuer: issuer,
    log: makeLog() as any,
    enqueueUnload: async (id: string) => {
      unloadsEnqueued.push(id)
    },
  }
  return { deps, prisma, issuer, calls, unloadsEnqueued, cardIssuerId: card.id }
}

async function seedMovement(prisma: any, direction: "LOAD" | "UNLOAD", amount: string, extra: Record<string, unknown> = {}) {
  const { newMovementId, referenceFor } = await import("../src/workers/card-movement.processor.js")
  const id = newMovementId()
  prisma.seed("cardMovement", [{ id, userId: "u1", direction, amount: new Prisma.Decimal(amount), reference: referenceFor(id), ...extra }])
  return id
}

describe("referenceFor", () => {
  test("is the sha256 of the movement id and never collides for distinct ids", async () => {
    const { referenceFor, newMovementId } = await import("../src/workers/card-movement.processor.js")
    const { createHash } = await import("node:crypto")
    const id = newMovementId()
    expect(referenceFor(id)).toBe(createHash("sha256").update(id).digest("hex"))
    expect(referenceFor(id)).toHaveLength(64)
    const refs = new Set(Array.from({ length: 1000 }, () => referenceFor(newMovementId())))
    expect(refs.size).toBe(1000)
  })

  test("the database rejects a second movement with the same reference", async () => {
    const prisma = makeFakePrisma()
    const id = await seedMovement(prisma, "LOAD", "1")
    const { referenceFor } = await import("../src/workers/card-movement.processor.js")
    await expect(
      prisma.cardMovement.create({ data: { userId: "u1", direction: "LOAD", amount: new Prisma.Decimal("1"), reference: referenceFor(id) } }),
    ).rejects.toMatchObject({ code: "P2002" })
  })
})

describe("processLoad", () => {
  test("settles on-chain with the operator, then funds the card and credits cardBalance", async () => {
    const { processLoad } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma, issuer, calls, cardIssuerId } = await makeDeps({ walletBalance: "100" })
    const id = await seedMovement(prisma, "LOAD", "25")

    const status = await processLoad(deps, id)

    expect(status).toBe("COMPLETED")
    expect(calls).toEqual([
      { method: "settle_card_spend", user: USER_ADDRESS, amount: 250_000_000n, reference: prisma.rows("cardMovement")[0]!.reference },
    ])
    expect(issuer.balanceOf(cardIssuerId)).toBe("25")
    const user = prisma.rows("user")[0]!
    expect(user.cardBalance.toFixed()).toBe("25")
    expect(user.walletBalance.toFixed()).toBe("100") // debited by the indexer, not here
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "COMPLETED", txHash: "settlehash" })
    expect(prisma.rows("transaction")[0]).toMatchObject({ type: "CARD_LOAD", account: "CARD" })
    expect(prisma.rows("transaction")[0]!.amount.toFixed()).toBe("25")
  })

  test("is idempotent: a second run changes nothing and makes no further calls", async () => {
    const { processLoad } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma, issuer, calls, cardIssuerId } = await makeDeps()
    const id = await seedMovement(prisma, "LOAD", "25")
    await processLoad(deps, id)
    await processLoad(deps, id)
    expect(calls).toHaveLength(1)
    expect(issuer.balanceOf(cardIssuerId)).toBe("25")
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("25")
    expect(prisma.rows("transaction")).toHaveLength(1)
  })

  test("a DuplicateReference answer means the settlement already happened; funding continues", async () => {
    const { processLoad } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma } = await makeDeps({ settle: async () => ({ outcome: "duplicate" }) })
    const id = await seedMovement(prisma, "LOAD", "5")
    expect(await processLoad(deps, id)).toBe("COMPLETED")
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("5")
  })

  test("an on-chain rejection (InsufficientBalance) fails the load without funding the card", async () => {
    const { processLoad } = await import("../src/workers/card-movement.processor.js")
    const { VaultRejected } = await import("../src/lib/stellar/vault.js")
    const { deps, prisma, issuer, cardIssuerId } = await makeDeps({
      settle: async () => {
        throw new VaultRejected("InsufficientBalance")
      },
    })
    const id = await seedMovement(prisma, "LOAD", "500")
    expect(await processLoad(deps, id)).toBe("FAILED")
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "FAILED", failureReason: "InsufficientBalance" })
    expect(issuer.balanceOf(cardIssuerId)).toBe("0")
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("0")
    expect(prisma.rows("transaction")).toHaveLength(0)
  })

  test("resumes after a crash between settlement and funding without settling twice", async () => {
    const { processLoad } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma, calls } = await makeDeps()
    const id = await seedMovement(prisma, "LOAD", "7", { status: "SETTLED", txHash: "earlier" })
    expect(await processLoad(deps, id)).toBe("COMPLETED")
    expect(calls).toHaveLength(0)
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("7")
  })

  test("an issuer failure after settlement is retried; the final failure returns the funds with a compensating unload", async () => {
    const { processLoad, compensateFailedLoad } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma, issuer, calls, unloadsEnqueued, cardIssuerId } = await makeDeps()
    issuer.failNextFunding = 1
    const id = await seedMovement(prisma, "LOAD", "9")

    await expect(processLoad(deps, id)).rejects.toThrow("simulated funding failure")
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "SETTLED" })
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("0")

    await compensateFailedLoad(deps, id, "issuer down")

    const [load, comp] = prisma.rows("cardMovement")
    expect(load).toMatchObject({ status: "FAILED", failureReason: "issuer down" })
    expect(comp).toMatchObject({ direction: "UNLOAD", status: "SETTLED", compensatesId: id })
    expect(comp!.amount.toFixed()).toBe("9")
    expect(comp!.reference).not.toBe(load!.reference)
    expect(unloadsEnqueued).toEqual([comp!.id])

    // The compensation skips the card step and refunds on-chain.
    const { processUnload } = await import("../src/workers/card-movement.processor.js")
    expect(await processUnload(deps, comp!.id)).toBe("COMPLETED")
    expect(calls.map((c) => c.method)).toEqual(["settle_card_spend", "credit_refund"])
    expect(calls[1]).toMatchObject({ amount: 90_000_000n, reference: comp!.reference })
    expect(issuer.balanceOf(cardIssuerId)).toBe("0")
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("0")
    expect(prisma.rows("transaction")).toHaveLength(0)
  })

  test("a load that never settled is just marked FAILED on final failure", async () => {
    const { compensateFailedLoad } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma, unloadsEnqueued } = await makeDeps()
    const id = await seedMovement(prisma, "LOAD", "9")
    await compensateFailedLoad(deps, id, "rpc down")
    expect(prisma.rows("cardMovement")).toHaveLength(1)
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "FAILED" })
    expect(unloadsEnqueued).toEqual([])
  })
})

describe("processUnload", () => {
  test("with a treasury key: defunds the card, debits cardBalance, then credits the vault", async () => {
    const { processUnload } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma, issuer, calls, cardIssuerId } = await makeDeps({ cardBalance: "30" })
    await issuer.fundCard(cardIssuerId, "30", "seed")
    const id = await seedMovement(prisma, "UNLOAD", "12")

    expect(await processUnload(deps, id)).toBe("COMPLETED")

    expect(issuer.balanceOf(cardIssuerId)).toBe("18")
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("18")
    expect(prisma.rows("user")[0]!.walletBalance.toFixed()).toBe("100") // credited by the indexer
    expect(calls).toEqual([{ method: "credit_refund", user: USER_ADDRESS, amount: 120_000_000n, reference: prisma.rows("cardMovement")[0]!.reference }])
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "COMPLETED", txHash: "refundhash" })
    expect(prisma.rows("transaction")[0]).toMatchObject({ type: "CARD_UNLOAD", account: "CARD" })
    expect(prisma.rows("transaction")[0]!.amount.toFixed()).toBe("-12")
  })

  test("without a treasury key: the card step completes and the movement waits in PENDING_TREASURY", async () => {
    const { processUnload } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma, calls } = await makeDeps({ cardBalance: "30", treasury: false })
    const id = await seedMovement(prisma, "UNLOAD", "12")

    expect(await processUnload(deps, id)).toBe("PENDING_TREASURY")
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("18")
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "PENDING_TREASURY" })
    expect(calls).toHaveLength(0)

    // Later, an operator with the key finishes it (scripts/process-pending-unloads.ts).
    const { vault, calls: later } = makeVault()
    expect(await processUnload({ ...deps, vault }, id)).toBe("COMPLETED")
    expect(later).toEqual([{ method: "credit_refund", user: USER_ADDRESS, amount: 120_000_000n, reference: prisma.rows("cardMovement")[0]!.reference }])
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("18") // not debited twice
    expect(prisma.rows("transaction")).toHaveLength(1)
  })

  test("is idempotent across retries", async () => {
    const { processUnload } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma, calls } = await makeDeps({ cardBalance: "30" })
    const id = await seedMovement(prisma, "UNLOAD", "12")
    await processUnload(deps, id)
    await processUnload(deps, id)
    expect(calls).toHaveLength(1)
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("18")
    expect(prisma.rows("transaction")).toHaveLength(1)
  })

  test("an unload above cardBalance at processing time fails before touching the issuer", async () => {
    const { processUnload } = await import("../src/workers/card-movement.processor.js")
    const { deps, prisma, issuer, calls, cardIssuerId } = await makeDeps({ cardBalance: "5" })
    const id = await seedMovement(prisma, "UNLOAD", "12")
    expect(await processUnload(deps, id)).toBe("FAILED")
    expect(issuer.balanceOf(cardIssuerId)).toBe("0")
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "FAILED", failureReason: "InsufficientCardBalance" })
    expect(calls).toHaveLength(0)
  })

  test("a rejected credit_refund leaves the movement PENDING_TREASURY for an operator", async () => {
    const { processUnload } = await import("../src/workers/card-movement.processor.js")
    const { VaultRejected } = await import("../src/lib/stellar/vault.js")
    const { deps, prisma } = await makeDeps({
      cardBalance: "30",
      refund: async () => {
        throw new VaultRejected("Paused")
      },
    })
    const id = await seedMovement(prisma, "UNLOAD", "12")
    expect(await processUnload(deps, id)).toBe("PENDING_TREASURY")
    expect(prisma.rows("cardMovement")[0]).toMatchObject({ status: "PENDING_TREASURY", failureReason: "Paused" })
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("18")
  })
})
