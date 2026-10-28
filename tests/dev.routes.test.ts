import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"
import Fastify from "fastify"
import fastifySensible from "@fastify/sensible"

import { makeFakePrisma } from "./fakes/prisma.js"
import { USER_ADDRESS, makeRedis, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

describe("dev route registration", () => {
  test("is enabled only outside production and only with the mock issuer", async () => {
    const { shouldRegisterDevRoutes } = await import("../src/modules/dev/dev.routes.js")
    expect(shouldRegisterDevRoutes({ NODE_ENV: "development", CARD_ISSUER: "mock" })).toBe(true)
    expect(shouldRegisterDevRoutes({ NODE_ENV: "test", CARD_ISSUER: "mock" })).toBe(true)
    expect(shouldRegisterDevRoutes({ NODE_ENV: "production", CARD_ISSUER: "mock" })).toBe(false)
    expect(shouldRegisterDevRoutes({ NODE_ENV: "development", CARD_ISSUER: "sudo" })).toBe(false)
    expect(shouldRegisterDevRoutes({ NODE_ENV: "production", CARD_ISSUER: "sudo" })).toBe(false)
  })
})

describe("POST /dev/mock-card-spend", () => {
  async function makeApp(cardBalance: string) {
    const prisma = makeFakePrisma()
    prisma.seed("user", [
      {
        id: "0f4e7b5e-6d0a-4a5c-9c6f-2c7a0a3f1d11",
        stellarAddress: USER_ADDRESS,
        username: "levi",
        cardBalance: new Prisma.Decimal(cardBalance),
        walletBalance: new Prisma.Decimal("100"),
      },
    ])
    prisma.seed("card", [{ id: "card-1", userId: "0f4e7b5e-6d0a-4a5c-9c6f-2c7a0a3f1d11", issuer: "MOCK", issuerId: "mock_abc", last4: "1234", expiryMonth: "12", expiryYear: "30" }])

    const app = Fastify()
    await app.register(fastifySensible)
    app.decorate("prisma", prisma as any)
    app.decorate("redis", makeRedis() as any)
    const { registerDevRoutes } = await import("../src/modules/dev/dev.routes.js")
    await app.register(registerDevRoutes, { prefix: "/api/v1" })
    await app.ready()
    return { app, prisma }
  }

  test("drives the real webhook handler: debits cardBalance and writes a SPEND row", async () => {
    const { app, prisma } = await makeApp("50")
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/mock-card-spend",
      payload: { userId: "0f4e7b5e-6d0a-4a5c-9c6f-2c7a0a3f1d11", amount: "12.5", merchantName: "Bolt" },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.result).toEqual({ ok: true })
    expect(body.cardBalance).toBe("37.5")
    expect(body.webhookEventId).toMatch(/^mockspend_/)

    const user = prisma.rows("user")[0]!
    expect(user.cardBalance.toFixed()).toBe("37.5")
    expect(user.walletBalance.toFixed()).toBe("100")
    const tx = prisma.rows("transaction")[0]!
    expect(tx).toMatchObject({ type: "SPEND", account: "CARD", description: "Bolt charge" })
    expect(tx.amount.toFixed()).toBe("-12.5")
    await app.close()
  })

  test("a spend above cardBalance is rejected and nothing changes", async () => {
    const { app, prisma } = await makeApp("5")
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/mock-card-spend",
      payload: { userId: "0f4e7b5e-6d0a-4a5c-9c6f-2c7a0a3f1d11", amount: "12.5" },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toBe("Insufficient card balance")
    expect(prisma.rows("user")[0]!.cardBalance.toFixed()).toBe("5")
    expect(prisma.rows("transaction")).toHaveLength(0)
    await app.close()
  })

  test("validates the body", async () => {
    const { app } = await makeApp("5")
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/dev/mock-card-spend",
      payload: { userId: "0f4e7b5e-6d0a-4a5c-9c6f-2c7a0a3f1d11", amount: "-1" },
    })
    expect(bad.statusCode).toBe(400)
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/dev/mock-card-spend",
      payload: { userId: "11111111-1111-4111-8111-111111111111", amount: "1" },
    })
    expect(unknown.statusCode).toBe(404)
    await app.close()
  })

  test("the generated webhook carries a valid HMAC for the configured secret", async () => {
    const { buildMockSpendWebhook } = await import("../src/modules/dev/dev.routes.js")
    const { createHmac } = await import("node:crypto")
    const { rawBody, signature, body } = buildMockSpendWebhook({
      cardIssuerId: "mock_abc",
      amount: "1",
      merchantName: "M",
      merchantCategory: "c",
    })
    expect(signature).toBe(createHmac("sha256", "test-webhook-secret").update(rawBody).digest("hex"))
    expect(body.data.object.card).toBe("mock_abc")
    expect(body.type).toBe("transaction.created")
  })
})
