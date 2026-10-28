import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { OTHER_ADDRESS, USER_ADDRESS, makeHttpErrors, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

const HASH = "ab".repeat(32)

function makeApp() {
  const prisma = makeFakePrisma()
  prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS }, { id: "u2", stellarAddress: OTHER_ADDRESS }])
  prisma.seed("deposit", [
    { id: "d1", userId: "u1", txHash: HASH, eventId: "e1", amountRaw: "100000000", amount: new Prisma.Decimal("10"), ledger: 5, createdAt: new Date("2026-01-01") },
    { id: "d2", userId: "u1", txHash: "cd".repeat(32), eventId: "e2", amountRaw: "1", amount: new Prisma.Decimal("0.0000001"), ledger: 6, createdAt: new Date("2026-01-02") },
    { id: "d3", userId: "u2", txHash: "ef".repeat(32), eventId: "e3", amountRaw: "5", amount: new Prisma.Decimal("0.0000005"), ledger: 7 },
  ])
  return { prisma, httpErrors: makeHttpErrors() } as any
}

describe("listMyDeposits", () => {
  test("returns the caller's deposits newest first with plain decimal amounts", async () => {
    const { listMyDeposits } = await import("../src/modules/deposits/deposits.service.js")
    const result = await listMyDeposits(makeApp(), USER_ADDRESS)
    expect(result.map((d) => d.id)).toEqual(["d2", "d1"])
    expect(result[0]).toMatchObject({ amount: "0.0000001", amountRaw: "1", ledger: 6, eventId: "e2" })
  })

  test("404 for an unknown user", async () => {
    const { listMyDeposits } = await import("../src/modules/deposits/deposits.service.js")
    await expect(listMyDeposits(makeApp(), "GAL5BE6C7TTJXOZ2OIZXDTJX6K56ZOBUGEFOF3GE2OQUXACSA34N3WSQ")).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe("getDepositByHash", () => {
  test("returns the caller's deposit by Stellar transaction hash", async () => {
    const { getDepositByHash } = await import("../src/modules/deposits/deposits.service.js")
    const result = await getDepositByHash(makeApp(), USER_ADDRESS, HASH)
    expect(result).toMatchObject({ id: "d1", amount: "10", txHash: HASH })
  })

  test("does not reveal another user's deposit", async () => {
    const { getDepositByHash } = await import("../src/modules/deposits/deposits.service.js")
    await expect(getDepositByHash(makeApp(), USER_ADDRESS, "ef".repeat(32))).rejects.toMatchObject({ statusCode: 404 })
  })
})
