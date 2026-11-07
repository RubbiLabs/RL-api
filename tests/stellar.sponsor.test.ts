import { beforeAll, describe, expect, mock, test } from "bun:test"
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk"
import fastifyPlugin from "fastify-plugin"

import { makeFakePrisma } from "./fakes/prisma.js"
import { ZERO_SEED, seedEnv } from "./helpers.js"

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

const fakePrisma = makeFakePrisma()
mock.module("../src/plugins/prisma.js", () => ({
  prismaPlugin: fastifyPlugin(async (app: any) => {
    app.decorate("prisma", fakePrisma)
  }),
}))

const userKey = Keypair.random()
const strangerKey = Keypair.random()
const sponsorKey = Keypair.fromSecret(ZERO_SEED)

const SUBSCRIPTIONS_CONTRACT = "CDWMLKAUMXHLSBOKKCK5A4ECUP2VIIHXAL7MVQ5TEFLE3QUXZRMDC3PC"
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
const FOREIGN_CONTRACT = "CBGARSQ7BY4345DNX76LWT4VXEHRRFJMNW46SCX7DRHBILL5V6RJN699"

beforeAll(() => {
  seedEnv()
})

async function build() {
  const { buildApp } = await import("../src/app.js")
  const app = await buildApp()
  await app.ready()
  return app
}

function makeJwtToken(app: any, address: string) {
  return app.jwt.sign({ sub: address })
}

function buildInvokeContractTx(
  sourceKey: Keypair,
  contractId: string,
  functionName: string,
  args: xdr.ScVal[] = [],
  fee = BASE_FEE,
) {
  const account = new Account(sourceKey.publicKey(), "100")
  const tx = new TransactionBuilder(account, {
    fee,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: functionName,
        args,
      }),
    )
    .setTimeout(300)
    .build()
  tx.sign(sourceKey)
  return tx.toXDR()
}

describe("POST /stellar/sponsor", () => {
  test("accepts an allowed contract call, wraps in fee-bump and returns the hash", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey())

    const txXdr = buildInvokeContractTx(userKey, SUBSCRIPTIONS_CONTRACT, "subscribe", [
      xdr.ScVal.scvU64(new xdr.Uint64(1n)),
    ])

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: txXdr },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.hash).toBeDefined()
    expect(typeof body.hash).toBe("string")
    expect(body.transaction).toBeDefined()

    await app.close()
  })

  test("accepts a USDC change_trust operation", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey())

    const account = new Account(userKey.publicKey(), "101")
    const usdcAsset = new Asset("USDC", strangerKey.publicKey())
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset: usdcAsset }))
      .setTimeout(300)
      .build()
    tx.sign(userKey)

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: tx.toXDR() },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().hash).toBeDefined()
    await app.close()
  })

  test("accepts an approve call with spender = subscriptions contract", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey())

    const txXdr = buildInvokeContractTx(userKey, USDC_SAC, "approve", [
      new Address(userKey.publicKey()).toScVal(),
      new Address(SUBSCRIPTIONS_CONTRACT).toScVal(),
      xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: new xdr.Uint64(100n), hi: new xdr.Int64(0n) })),
      xdr.ScVal.scvU32(1000),
    ])

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: txXdr },
    })

    expect(res.statusCode).toBe(200)
    await app.close()
  })

  test("rejects approve when spender is NOT the subscriptions contract", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey())

    const txXdr = buildInvokeContractTx(userKey, USDC_SAC, "approve", [
      new Address(userKey.publicKey()).toScVal(),
      new Address(strangerKey.publicKey()).toScVal(),
      xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: new xdr.Uint64(100n), hi: new xdr.Int64(0n) })),
      xdr.ScVal.scvU32(1000),
    ])

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: txXdr },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/spender/i)
    await app.close()
  })

  test("rejects standard payment operations with 400", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey())

    const account = new Account(userKey.publicKey(), "102")
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: strangerKey.publicKey(), asset: Asset.native(), amount: "10" }))
      .setTimeout(300)
      .build()
    tx.sign(userKey)

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: tx.toXDR() },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/operation/i)
    await app.close()
  })

  test("rejects transactions with multiple operations with 400", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey())

    const account = new Account(userKey.publicKey(), "103")
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(
        Operation.invokeContractFunction({
          contract: SUBSCRIPTIONS_CONTRACT,
          function: "subscribe",
          args: [xdr.ScVal.scvU64(new xdr.Uint64(1n))],
        }),
      )
      .addOperation(
        Operation.invokeContractFunction({
          contract: SUBSCRIPTIONS_CONTRACT,
          function: "cancel_subscription",
          args: [xdr.ScVal.scvU64(new xdr.Uint64(1n))],
        }),
      )
      .setTimeout(300)
      .build()
    tx.sign(userKey)

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: tx.toXDR() },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/exactly one operation/i)
    await app.close()
  })

  test("rejects foreign contract calls with 400", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey())

    const txXdr = buildInvokeContractTx(userKey, FOREIGN_CONTRACT, "subscribe")

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: txXdr },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/allowlist/i)
    await app.close()
  })

  test("rejects non-allowlisted function on a valid contract with 400", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey())

    const txXdr = buildInvokeContractTx(userKey, SUBSCRIPTIONS_CONTRACT, "malicious_drain")

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: txXdr },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/allowlist/i)
    await app.close()
  })

  test("rejects when inner source does not match JWT sub with 400", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey()) // JWT is userKey

    // Transaction signed and sourced by strangerKey
    const txXdr = buildInvokeContractTx(strangerKey, SUBSCRIPTIONS_CONTRACT, "subscribe")

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: txXdr },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/does not match authenticated user/i)
    await app.close()
  })

  test("rejects when inner transaction fee exceeds cap with 400", async () => {
    const app = await build()
    const token = makeJwtToken(app, userKey.publicKey())

    // 1_000_000 stroops > default cap 500_000
    const txXdr = buildInvokeContractTx(userKey, SUBSCRIPTIONS_CONTRACT, "subscribe", [], 1_000_000)

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/stellar/sponsor",
      headers: { authorization: `Bearer ${token}` },
      payload: { transaction: txXdr },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/exceeds maximum/i)
    await app.close()
  })
})
