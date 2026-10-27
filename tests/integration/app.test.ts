import { beforeAll, describe, expect, mock, test } from "bun:test"
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk"
import fastifyPlugin from "fastify-plugin"

import { makeFakePrisma } from "../fakes/prisma.js"
import { ZERO_SEED, seedEnv } from "../helpers.js"

// No Redis or BullMQ in tests: queue producers and workers are stubbed.
mock.module("ioredis", () => {
  const store: Record<string, string> = {}
  class MockRedis {
    get = async (key: string) => store[key] ?? null
    set = async (key: string, value: string) => {
      store[key] = value
      return "OK"
    }
    exists = async (key: string) => (key in store ? 1 : 0)
    on() {
      return this
    }
    quit() {
      return Promise.resolve()
    }
  }
  return { default: MockRedis, Redis: MockRedis }
})

mock.module("bullmq", () => ({
  Worker: class {
    on() {
      return this
    }
    close() {
      return Promise.resolve()
    }
  },
  Queue: class {
    add() {
      return Promise.resolve({ id: "mock" })
    }
    upsertJobScheduler() {
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
  },
}))

// The database is the in-memory fake, decorated by a stand-in prisma plugin.
const fakePrisma = makeFakePrisma()
mock.module("../../src/plugins/prisma.js", () => ({
  prismaPlugin: fastifyPlugin(async (app: any) => {
    app.decorate("prisma", fakePrisma)
  }),
}))

// The server key must match SEP10_SIGNING_SECRET in TEST_ENV: the config
// module is evaluated once per test process, so every file shares it.
const server = Keypair.fromSecret(ZERO_SEED)
const client = Keypair.random()

beforeAll(() => {
  seedEnv()
})

async function build() {
  const { buildApp } = await import("../../src/app.js")
  const app = await buildApp()
  await app.ready()
  return app
}

describe("buildApp", () => {
  test("serves health and swagger", async () => {
    const app = await build()
    const health = await app.inject({ method: "GET", url: "/health" })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toMatchObject({ status: "ok", service: "rubbi-api" })

    const docs = await app.inject({ method: "GET", url: "/docs" })
    expect(docs.statusCode).toBe(200)
    expect(docs.body).toContain("Swagger UI")
    await app.close()
  })

  test("exposes the public Stellar configuration without secrets", async () => {
    const app = await build()
    const response = await app.inject({ method: "GET", url: "/api/v1/stellar/config" })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({
      network: "testnet",
      usdcSacId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      contracts: { vault: "CBGARSQ7BY4345DNX76LWT4VXEHRRFJMNW46SCX7DRHBILL5V6RJN6KR" },
    })
    expect(JSON.stringify(body)).not.toMatch(/SAAAA|SECRET/i)
    await app.close()
  })

  test("protected routes reject requests without a JWT", async () => {
    const app = await build()
    for (const url of [
      "/api/v1/users/me",
      "/api/v1/cards/me",
      "/api/v1/cards/movements",
      "/api/v1/deposits",
      "/api/v1/transactions",
      "/api/v1/subscriptions/me",
      "/api/v1/payroll/schedules",
      "/api/v1/dashboard/stats",
    ]) {
      const response = await app.inject({ method: "GET", url })
      expect([url, response.statusCode]).toEqual([url, 401])
    }
    for (const url of ["/api/v1/cards/load", "/api/v1/cards/unload", "/api/v1/users/username"]) {
      const response = await app.inject({ method: "POST", url, payload: { amount: "1", username: "abc" } })
      expect([url, response.statusCode]).toEqual([url, 401])
    }
    await app.close()
  })

  test("SEP-10 end to end: challenge, sign, token, then an authenticated call", async () => {
    const app = await build()

    const challenge = await app.inject({ method: "GET", url: `/api/v1/auth/challenge?account=${client.publicKey()}` })
    expect(challenge.statusCode).toBe(200)
    const { transaction, network_passphrase } = challenge.json()
    expect(network_passphrase).toBe(Networks.TESTNET)

    const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET)
    tx.sign(client)
    const token = await app.inject({ method: "POST", url: "/api/v1/auth/token", payload: { transaction: tx.toXDR() } })
    expect(token.statusCode).toBe(200)
    const jwt = token.json().token
    expect(typeof jwt).toBe("string")

    const me = await app.inject({ method: "GET", url: "/api/v1/users/me", headers: { authorization: `Bearer ${jwt}` } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ stellarAddress: client.publicKey(), username: null, walletBalance: "0", cardBalance: "0", card: null })

    const username = await app.inject({
      method: "POST",
      url: "/api/v1/users/username",
      headers: { authorization: `Bearer ${jwt}` },
      payload: { username: "levi_o" },
    })
    expect(username.statusCode).toBe(200)
    expect(username.json()).toMatchObject({ username: "levi_o", card: { issuer: "MOCK" } })

    const unsigned = await app.inject({ method: "POST", url: "/api/v1/auth/token", payload: { transaction } })
    expect(unsigned.statusCode).toBe(401)

    const contract = await app.inject({ method: "GET", url: "/api/v1/auth/challenge?account=CBGARSQ7BY4345DNX76LWT4VXEHRRFJMNW46SCX7DRHBILL5V6RJN6KR" })
    expect(contract.statusCode).toBe(400)
    expect(contract.json().message).toMatch(/SEP-45/)
    await app.close()
  })

  test("the dev mock-spend route is registered under the mock issuer outside production", async () => {
    const app = await build()
    const response = await app.inject({ method: "POST", url: "/api/v1/dev/mock-card-spend", payload: {} })
    expect(response.statusCode).toBe(400) // registered; body validation fails
    await app.close()
  })

  test("the public plans endpoint needs no JWT", async () => {
    const app = await build()
    const response = await app.inject({ method: "GET", url: "/api/v1/subscriptions/plans" })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
    await app.close()
  })
})
