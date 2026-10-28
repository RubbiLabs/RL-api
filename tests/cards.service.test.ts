import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { USER_ADDRESS, makeHttpErrors, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

function makeApp(opts: { walletBalance?: string; cardBalance?: string; cardStatus?: string; card?: boolean } = {}) {
  const prisma = makeFakePrisma()
  prisma.seed("user", [
    {
      id: "u1",
      stellarAddress: USER_ADDRESS,
      walletBalance: new Prisma.Decimal(opts.walletBalance ?? "100"),
      cardBalance: new Prisma.Decimal(opts.cardBalance ?? "40"),
    },
  ])
  if (opts.card !== false) {
    prisma.seed("card", [
      { id: "card-1", userId: "u1", issuer: "MOCK", issuerId: "mock_1", last4: "1234", expiryMonth: "12", expiryYear: "30", status: opts.cardStatus ?? "ACTIVE" },
    ])
  }
  const enqueued: Array<["load" | "unload", string]> = []
  const issuerCalls: string[] = []
  const app = {
    prisma,
    httpErrors: makeHttpErrors(),
    cardMovements: {
      enqueueLoad: async (id: string) => {
        enqueued.push(["load", id])
      },
      enqueueUnload: async (id: string) => {
        enqueued.push(["unload", id])
      },
    },
    cardIssuer: {
      name: "MOCK",
      freezeCard: async () => {
        issuerCalls.push("freeze")
      },
      unfreezeCard: async () => {
        issuerCalls.push("unfreeze")
      },
      getCardDetails: async () => ({ id: "mock_1", last4: "1234", expiryMonth: "12", expiryYear: "30", status: "ACTIVE" }),
    },
  } as any
  return { app, prisma, enqueued, issuerCalls }
}

describe("getMyCard", () => {
  test("returns the card with both balances", async () => {
    const { getMyCard } = await import("../src/modules/cards/cards.service.js")
    const { app } = makeApp()
    const result = await getMyCard(app, USER_ADDRESS)
    expect(result).toMatchObject({ issuer: "MOCK", last4: "1234", cardBalance: "40", walletBalance: "100" })
  })

  test("404 without a card", async () => {
    const { getMyCard } = await import("../src/modules/cards/cards.service.js")
    const { app } = makeApp({ card: false })
    await expect(getMyCard(app, USER_ADDRESS)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe("freeze / unfreeze / reveal", () => {
  test("freeze and unfreeze call the issuer and update the card", async () => {
    const { freezeMyCard, unfreezeMyCard } = await import("../src/modules/cards/cards.service.js")
    const { app, prisma, issuerCalls } = makeApp()
    expect(await freezeMyCard(app, USER_ADDRESS)).toEqual({ status: "frozen" })
    expect(prisma.rows("card")[0]).toMatchObject({ status: "FROZEN" })
    expect(await unfreezeMyCard(app, USER_ADDRESS)).toEqual({ status: "active" })
    expect(prisma.rows("card")[0]).toMatchObject({ status: "ACTIVE" })
    expect(issuerCalls).toEqual(["freeze", "unfreeze"])
  })

  test("reveal returns null pan for a mock card", async () => {
    const { revealMyCardNumber } = await import("../src/modules/cards/cards.service.js")
    const { app } = makeApp()
    const result = await revealMyCardNumber(app, USER_ADDRESS)
    expect(result.pan).toBeNull()
    expect(result.issuer).toBe("MOCK")
  })
})

describe("loadCard", () => {
  test("creates a PENDING LOAD with reference = sha256(id) and queues it", async () => {
    const { loadCard } = await import("../src/modules/cards/cards.service.js")
    const { referenceFor } = await import("../src/workers/card-movement.processor.js")
    const { app, prisma, enqueued } = makeApp({ walletBalance: "100" })

    const result = await loadCard(app, USER_ADDRESS, "25.5")

    expect(result).toMatchObject({ direction: "LOAD", status: "PENDING", amount: "25.5" })
    expect(result.reference).toBe(referenceFor(result.id))
    expect(enqueued).toEqual([["load", result.id]])
    expect(prisma.rows("user")[0]!.walletBalance.toFixed()).toBe("100") // untouched until the chain confirms
  })

  test("rejects more than walletBalance", async () => {
    const { loadCard } = await import("../src/modules/cards/cards.service.js")
    const { app, enqueued } = makeApp({ walletBalance: "10" })
    await expect(loadCard(app, USER_ADDRESS, "10.0000001")).rejects.toMatchObject({ statusCode: 400 })
    expect(enqueued).toHaveLength(0)
  })

  test("counts loads still in flight against walletBalance", async () => {
    const { loadCard } = await import("../src/modules/cards/cards.service.js")
    const { app } = makeApp({ walletBalance: "10" })
    await loadCard(app, USER_ADDRESS, "6")
    await expect(loadCard(app, USER_ADDRESS, "5")).rejects.toThrow(/4 USDC available/)
    await loadCard(app, USER_ADDRESS, "4")
  })

  test("rejects when the card is not active", async () => {
    const { loadCard } = await import("../src/modules/cards/cards.service.js")
    const { app } = makeApp({ cardStatus: "FROZEN" })
    await expect(loadCard(app, USER_ADDRESS, "1")).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe("unloadCard", () => {
  test("creates a PENDING UNLOAD and queues it", async () => {
    const { unloadCard } = await import("../src/modules/cards/cards.service.js")
    const { app, enqueued } = makeApp({ cardBalance: "40" })
    const result = await unloadCard(app, USER_ADDRESS, "40")
    expect(result).toMatchObject({ direction: "UNLOAD", status: "PENDING", amount: "40" })
    expect(enqueued).toEqual([["unload", result.id]])
  })

  test("rejects more than cardBalance, counting unloads in flight", async () => {
    const { unloadCard } = await import("../src/modules/cards/cards.service.js")
    const { app } = makeApp({ cardBalance: "40" })
    await expect(unloadCard(app, USER_ADDRESS, "40.1")).rejects.toMatchObject({ statusCode: 400 })
    await unloadCard(app, USER_ADDRESS, "30")
    await expect(unloadCard(app, USER_ADDRESS, "11")).rejects.toThrow(/10 USDC available/)
  })
})

describe("listMyCardMovements", () => {
  test("lists newest first", async () => {
    const { loadCard, unloadCard, listMyCardMovements } = await import("../src/modules/cards/cards.service.js")
    const { app } = makeApp()
    const a = await loadCard(app, USER_ADDRESS, "1")
    await new Promise((r) => setTimeout(r, 2))
    const b = await unloadCard(app, USER_ADDRESS, "2")
    const list = await listMyCardMovements(app, USER_ADDRESS)
    expect(list.map((m) => m.id)).toEqual([b.id, a.id])
  })
})
