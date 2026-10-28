import { beforeAll, describe, expect, test } from "bun:test"
import { Account, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk"
import { ZERO_SEED, makeHttpErrors, makeJwt, seedEnv } from "./helpers.js"

// The server key must match SEP10_SIGNING_SECRET in TEST_ENV: the config
// module is evaluated once per test process, so every file shares it.
const server = Keypair.fromSecret(ZERO_SEED)
const client = Keypair.random()
const stranger = Keypair.random()

beforeAll(() => {
  seedEnv()
})

function makeApp() {
  const users = new Map<string, { id: string; stellarAddress: string; username: string | null }>()
  return {
    prisma: {
      user: {
        upsert: async (args: { where: { stellarAddress: string } }) => {
          const address = args.where.stellarAddress
          const existing = users.get(address)
          if (existing) return existing
          const created = { id: `user-${users.size + 1}`, stellarAddress: address, username: null }
          users.set(address, created)
          return created
        },
      },
    },
    jwt: makeJwt(),
    httpErrors: makeHttpErrors(),
  } as any
}

function signedBy(transaction: string, ...signers: Keypair[]) {
  const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET)
  tx.sign(...signers)
  return tx.toXDR()
}

describe("SEP-10 challenge", () => {
  test("is signed by the server, targets the client and carries both domains", async () => {
    const { buildChallenge } = await import("../src/modules/auth/auth.service.js")
    const { transaction, network_passphrase } = buildChallenge(client.publicKey())

    expect(network_passphrase).toBe(Networks.TESTNET)
    const details = WebAuth.readChallengeTx(
      transaction,
      server.publicKey(),
      Networks.TESTNET,
      "localhost:3000",
      "localhost:3000",
    )
    expect(details.clientAccountID).toBe(client.publicKey())
    expect(details.matchedHomeDomain).toBe("localhost:3000")
    expect(details.tx.sequence).toBe("0")
  })
})

describe("SEP-10 token", () => {
  test("accepts a challenge signed by the client and issues a JWT with sub = address", async () => {
    const { buildChallenge, verifyChallengeAndIssueToken } = await import(
      "../src/modules/auth/auth.service.js"
    )
    const app = makeApp()
    const { transaction } = buildChallenge(client.publicKey())

    const result = await verifyChallengeAndIssueToken(app, signedBy(transaction, client))

    expect(result.token).toBe(`mock-token-${JSON.stringify({ sub: client.publicKey() })}`)
    expect(result.user.stellarAddress).toBe(client.publicKey())
    expect(result.user.username).toBeNull()
  })

  test("rejects a challenge signed by the wrong key", async () => {
    const { buildChallenge, verifyChallengeAndIssueToken } = await import(
      "../src/modules/auth/auth.service.js"
    )
    const { transaction } = buildChallenge(client.publicKey())

    await expect(
      verifyChallengeAndIssueToken(makeApp(), signedBy(transaction, stranger)),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  test("rejects an unsigned challenge", async () => {
    const { buildChallenge, verifyChallengeAndIssueToken } = await import(
      "../src/modules/auth/auth.service.js"
    )
    const { transaction } = buildChallenge(client.publicKey())

    await expect(verifyChallengeAndIssueToken(makeApp(), transaction)).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  test("rejects an expired challenge", async () => {
    const { verifyChallengeAndIssueToken } = await import("../src/modules/auth/auth.service.js")
    // Same shape as WebAuth.buildChallengeTx, with a validity window that
    // closed ten minutes ago.
    const now = Math.floor(Date.now() / 1000)
    const tx = new TransactionBuilder(new Account(server.publicKey(), "-1"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: now - 1200, maxTime: now - 600 },
    })
      .addOperation(
        Operation.manageData({
          name: "localhost:3000 auth",
          value: Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64"),
          source: client.publicKey(),
        }),
      )
      .addOperation(
        Operation.manageData({
          name: "web_auth_domain",
          value: "localhost:3000",
          source: server.publicKey(),
        }),
      )
      .build()
    tx.sign(server)
    const expired = tx.toXDR()

    await expect(
      verifyChallengeAndIssueToken(makeApp(), signedBy(expired, client)),
    ).rejects.toThrow(/expired|time bounds|Time/i)
  })

  test("rejects a challenge for another home domain", async () => {
    const { verifyChallengeAndIssueToken } = await import("../src/modules/auth/auth.service.js")
    const other = WebAuth.buildChallengeTx(
      server,
      client.publicKey(),
      "evil.example",
      300,
      Networks.TESTNET,
      "localhost:3000",
    )

    await expect(
      verifyChallengeAndIssueToken(makeApp(), signedBy(other, client)),
    ).rejects.toThrow(/home domain/i)
  })

  test("rejects a challenge for another web auth domain", async () => {
    const { verifyChallengeAndIssueToken } = await import("../src/modules/auth/auth.service.js")
    const other = WebAuth.buildChallengeTx(
      server,
      client.publicKey(),
      "localhost:3000",
      300,
      Networks.TESTNET,
      "auth.evil.example",
    )

    await expect(
      verifyChallengeAndIssueToken(makeApp(), signedBy(other, client)),
    ).rejects.toThrow(/web_auth_domain|web auth domain/i)
  })

  test("rejects a challenge signed by a different server key", async () => {
    const { verifyChallengeAndIssueToken } = await import("../src/modules/auth/auth.service.js")
    const other = WebAuth.buildChallengeTx(
      Keypair.random(),
      client.publicKey(),
      "localhost:3000",
      300,
      Networks.TESTNET,
      "localhost:3000",
    )

    await expect(
      verifyChallengeAndIssueToken(makeApp(), signedBy(other, client)),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  test("challenge query rejects contract accounts and malformed ids", async () => {
    const { challengeQuerySchema } = await import("../src/modules/auth/auth.schema.js")
    expect(challengeQuerySchema.safeParse({ account: client.publicKey() }).success).toBe(true)
    const contract = challengeQuerySchema.safeParse({
      account: "CBGARSQ7BY4345DNX76LWT4VXEHRRFJMNW46SCX7DRHBILL5V6RJN6KR",
    })
    expect(contract.success).toBe(false)
    expect(contract.success ? "" : contract.error.issues[0]?.message).toMatch(/SEP-45/)
    expect(challengeQuerySchema.safeParse({ account: "0xabc" }).success).toBe(false)
    expect(
      challengeQuerySchema.safeParse({ account: client.publicKey().toLowerCase() }).success,
    ).toBe(false)
  })
})
