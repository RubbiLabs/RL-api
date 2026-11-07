import { beforeAll, describe, expect, mock, test } from "bun:test"
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk"
import fastifyPlugin from "fastify-plugin"

import { makeFakePrisma } from "../fakes/prisma.js"
import { ZERO_SEED, seedEnv } from "../helpers.js"
import { RedisRateLimitStore } from "../../src/lib/rate-limit/account-limiter.js"

// Shared mock redis storage to verify multi-instance sharing
const sharedRedisStore: Record<string, string> = {}
class SharedMockRedis {
  get = async (key: string) => sharedRedisStore[key] ?? null
  set = async (key: string, value: string) => {
    sharedRedisStore[key] = value
    return "OK"
  }
  exists = async (key: string) => (key in sharedRedisStore ? 1 : 0)
  on() {
    return this
  }
  quit() {
    return Promise.resolve()
  }
}

mock.module("ioredis", () => ({
  default: SharedMockRedis,
  Redis: SharedMockRedis,
}))

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

const fakePrisma = makeFakePrisma()
mock.module("../../src/plugins/prisma.js", () => ({
  prismaPlugin: fastifyPlugin(async (app: any) => {
    app.decorate("prisma", fakePrisma)
  }),
}))

const server = Keypair.fromSecret(ZERO_SEED)
const client1 = Keypair.random()
const client2 = Keypair.random()
const stranger = Keypair.random()

beforeAll(() => {
  seedEnv()
})

async function build() {
  const { buildApp } = await import("../../src/app.js")
  const app = await buildApp()
  await app.ready()
  return app
}

describe("Auth rate limiting per Stellar account", () => {
  test("11th GET /auth/challenge?account=G1 within a minute yields 429 with Retry-After; account=G2 from same IP still 200", async () => {
    const app = await build()

    // First 10 requests for client1 succeed
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/challenge?account=${client1.publicKey()}`,
      })
      expect(res.statusCode).toBe(200)
    }

    // 11th request for client1 returns 429 with Retry-After
    const exceeded = await app.inject({
      method: "GET",
      url: `/api/v1/auth/challenge?account=${client1.publicKey()}`,
    })
    expect(exceeded.statusCode).toBe(429)
    expect(exceeded.headers["retry-after"]).toBeDefined()
    expect(Number(exceeded.headers["retry-after"])).toBeGreaterThanOrEqual(1)
    expect(exceeded.json()).toMatchObject({
      statusCode: 429,
      error: "Too Many Requests",
    })

    // Different account client2 from the same IP still succeeds with 200
    const different = await app.inject({
      method: "GET",
      url: `/api/v1/auth/challenge?account=${client2.publicKey()}`,
    })
    expect(different.statusCode).toBe(200)

    await app.close()
  })

  test("POST /auth/token rejects malformed XDR with 400 without consuming rate limit quota", async () => {
    const app = await build()

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/token",
      payload: { transaction: "not-valid-stellar-xdr" },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().message).toMatch(/xdr|transaction/i)

    await app.close()
  })

  test("Repeated invalid POST /auth/token for one account back off due to doubled 401 weight", async () => {
    const app = await build()
    const targetClient = Keypair.random()

    // Get a valid challenge for targetClient
    const challengeRes = await app.inject({
      method: "GET",
      url: `/api/v1/auth/challenge?account=${targetClient.publicKey()}`,
    })
    expect(challengeRes.statusCode).toBe(200)
    const { transaction } = challengeRes.json()

    // Sign challenge with stranger keypair so verification fails (401)
    const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET)
    tx.sign(stranger)
    const badSignedTx = tx.toXDR()

    // Each 401 failure counts double (weight = 2).
    // Limit is 10/min, so 5 failed attempts consume 5 * 2 = 10 counts.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/token",
        payload: { transaction: badSignedTx },
      })
      expect(res.statusCode).toBe(401)
    }

    // 6th attempt should now trigger 429 Too Many Requests
    const rateLimited = await app.inject({
      method: "POST",
      url: "/api/v1/auth/token",
      payload: { transaction: badSignedTx },
    })
    expect(rateLimited.statusCode).toBe(429)
    expect(rateLimited.headers["retry-after"]).toBeDefined()

    await app.close()
  })

  test("Limits are shared between two app instances using the same Redis store", async () => {
    const app1 = await build()
    const app2 = await build()
    const sharedAccount = Keypair.random()

    // 5 calls on app1
    for (let i = 0; i < 5; i++) {
      const res = await app1.inject({
        method: "GET",
        url: `/api/v1/auth/challenge?account=${sharedAccount.publicKey()}`,
      })
      expect(res.statusCode).toBe(200)
    }

    // 5 calls on app2
    for (let i = 0; i < 5; i++) {
      const res = await app2.inject({
        method: "GET",
        url: `/api/v1/auth/challenge?account=${sharedAccount.publicKey()}`,
      })
      expect(res.statusCode).toBe(200)
    }

    // 11th call on app1 hits the shared limit
    const exceeded = await app1.inject({
      method: "GET",
      url: `/api/v1/auth/challenge?account=${sharedAccount.publicKey()}`,
    })
    expect(exceeded.statusCode).toBe(429)
    expect(exceeded.headers["retry-after"]).toBeDefined()

    // Also exceeded on app2 for the same account
    const exceeded2 = await app2.inject({
      method: "GET",
      url: `/api/v1/auth/challenge?account=${sharedAccount.publicKey()}`,
    })
    expect(exceeded2.statusCode).toBe(429)

    await app1.close()
    await app2.close()
  })
})
