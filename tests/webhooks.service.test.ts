import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"
import { createHmac } from "node:crypto"

import { makeFakePrisma } from "./fakes/prisma.js"
import { TEST_ENV, USER_ADDRESS, makeHttpErrors, makeRedis, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

function sign(payload: object) {
  return createHmac("sha256", TEST_ENV.SUDO_WEBHOOK_SECRET).update(JSON.stringify(payload)).digest("hex")
}

function makeApp(cardBalance: string, redisSet: string | null = "OK") {
  const prisma = makeFakePrisma()
  prisma.seed("user", [
    { id: "u1", stellarAddress: USER_ADDRESS, cardBalance: new Prisma.Decimal(cardBalance), walletBalance: new Prisma.Decimal("99") },
  ])
  prisma.seed("card", [{ id: "card-1", userId: "u1", issuer: "MOCK", issuerId: "issuer-card-1", last4: "1234", expiryMonth: "12", expiryYear: "30" }])
  return {
    prisma,
    app: { prisma, redis: makeRedis(redisSet), httpErrors: makeHttpErrors() } as any,
  }
}

const spend = (amount: string | number, extra: Record<string, unknown> = {}) => ({
  _id: "evt-1",
  type: "card.charge",
  data: { cardId: "issuer-card-1", amount, merchantName: "Jumia", merchantCategory: "retail", ...extra },
})

describe("handleCardIssuerWebhook", () => {
  test("rejects an invalid signature", async () => {
    const { handleCardIssuerWebhook } = await import("../src/modules/webhooks/webhooks.service.js")
    const { app } = makeApp("50")
    const body = spend("10")
    await expect(handleCardIssuerWebhook(app, body, "deadbeef", JSON.stringify(body))).rejects.toMatchObject({ statusCode: 401 })
    await expect(handleCardIssuerWebhook(app, body, undefined, JSON.stringify(body))).rejects.toMatchObject({ statusCode: 401 })
  })

  test("debits cardBalance only and records a CARD ledger row", async () => {
    const { handleCardIssuerWebhook } = await import("../src/modules/webhooks/webhooks.service.js")
    const { app, prisma } = makeApp("50")
    const body = spend("12.5")

    const result = await handleCardIssuerWebhook(app, body, sign(body), JSON.stringify(body))

    expect(result).toEqual({ ok: true })
    const user = prisma.rows("user")[0]!
    expect(user.cardBalance.toFixed()).toBe("37.5")
    expect(user.walletBalance.toFixed()).toBe("99")
    const row = prisma.rows("transaction")[0]!
    expect(row).toMatchObject({ type: "SPEND", account: "CARD", userId: "u1" })
    expect(row.amount.toFixed()).toBe("-12.5")
    expect(row.balanceAfter.toFixed()).toBe("37.5")
    expect(row.metadata.webhookEventId).toBe("evt-1")
  })

  test("rejects a spend above cardBalance even when walletBalance would cover it", async () => {
    const { handleCardIssuerWebhook } = await import("../src/modules/webhooks/webhooks.service.js")
    const { app, prisma } = makeApp("5")
    const body = spend("12.5")
    await expect(handleCardIssuerWebhook(app, body, sign(body), JSON.stringify(body))).rejects.toMatchObject({
      statusCode: 400,
      message: "Insufficient card balance",
    })
    expect(prisma.rows("transaction")).toHaveLength(0)
  })

  test("authorization.request answers from cardBalance", async () => {
    const { handleCardIssuerWebhook } = await import("../src/modules/webhooks/webhooks.service.js")
    const { app } = makeApp("5")
    const ok = { ...spend("5"), type: "authorization.request" }
    expect(await handleCardIssuerWebhook(app, ok, sign(ok), JSON.stringify(ok))).toEqual({ statusCode: 200, data: { responseCode: "00" } })
    const declined = { ...spend("5.01"), type: "authorization.request" }
    expect(await handleCardIssuerWebhook(app, declined, sign(declined), JSON.stringify(declined))).toEqual({
      statusCode: 200,
      data: { responseCode: "51" },
    })
  })

  test("a merchant refund credits cardBalance only", async () => {
    const { handleCardIssuerWebhook } = await import("../src/modules/webhooks/webhooks.service.js")
    const { app, prisma } = makeApp("5")
    const body = {
      _id: "evt-r",
      type: "transaction.created",
      data: { object: { _id: "evt-r", card: "issuer-card-1", amount: "3", type: "refund", merchant: { name: "Jumia" } } },
    }
    const result = await handleCardIssuerWebhook(app, body, sign(body), JSON.stringify(body))
    expect(result).toEqual({ ok: true, credited: true })
    const user = prisma.rows("user")[0]!
    expect(user.cardBalance.toFixed()).toBe("8")
    expect(user.walletBalance.toFixed()).toBe("99")
    expect(prisma.rows("transaction")[0]).toMatchObject({ type: "REFUND", account: "CARD" })
  })

  test("duplicate webhook event ids are ignored", async () => {
    const { handleCardIssuerWebhook } = await import("../src/modules/webhooks/webhooks.service.js")
    const { app, prisma } = makeApp("50", null)
    const body = spend("1")
    expect(await handleCardIssuerWebhook(app, body, sign(body), JSON.stringify(body))).toEqual({ ok: true, duplicate: true })
    expect(prisma.rows("transaction")).toHaveLength(0)
  })

  test("processes the Sudo transaction.created payload shape", async () => {
    const { handleCardIssuerWebhook } = await import("../src/modules/webhooks/webhooks.service.js")
    const { app, prisma } = makeApp("50")
    const body = {
      _id: "sudo-1",
      type: "transaction.created",
      data: {
        object: {
          _id: "txn-9",
          card: { _id: "issuer-card-1" },
          amount: -20,
          type: "purchase",
          merchant: { name: "Shoprite", category: "grocery" },
          transactionMetadata: { type: "purchase" },
        },
      },
    }
    expect(await handleCardIssuerWebhook(app, body, sign(body), JSON.stringify(body))).toEqual({ ok: true })
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("30")
    expect(prisma.rows("transaction")[0]).toMatchObject({ description: "Shoprite charge" })
  })

  test("ignores unsupported events and non-positive amounts", async () => {
    const { handleCardIssuerWebhook } = await import("../src/modules/webhooks/webhooks.service.js")
    const { app } = makeApp("50")
    const other = { ...spend("1"), type: "card.created" }
    expect(await handleCardIssuerWebhook(app, other, sign(other), JSON.stringify(other))).toMatchObject({ ignored: true })
    const zero = spend("0")
    expect(await handleCardIssuerWebhook(app, zero, sign(zero), JSON.stringify(zero))).toMatchObject({ ignored: true })
  })
})
