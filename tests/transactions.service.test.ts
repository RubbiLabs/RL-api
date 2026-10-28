import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { USER_ADDRESS, makeHttpErrors, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

function makeApp(count = 5) {
  const prisma = makeFakePrisma()
  prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS }])
  prisma.seed(
    "transaction",
    Array.from({ length: count }, (_, i) => ({
      id: `t${i}`,
      userId: "u1",
      type: i % 2 ? "SPEND" : "DEPOSIT",
      account: i % 2 ? "CARD" : "WALLET",
      amount: new Prisma.Decimal(i % 2 ? "-1" : "1"),
      balanceAfter: new Prisma.Decimal(i),
      description: `row ${i}`,
      createdAt: new Date(2026, 0, i + 1),
    })),
  )
  return { prisma, httpErrors: makeHttpErrors() } as any
}

describe("listMyTransactions", () => {
  test("returns pages newest first with account and signed amounts", async () => {
    const { listMyTransactions } = await import("../src/modules/transactions/transactions.service.js")
    const result = await listMyTransactions(makeApp(), USER_ADDRESS, { page: 1, pageSize: 2 })
    expect(result).toMatchObject({ page: 1, pageSize: 2, total: 5 })
    expect(result.items.map((i) => i.id)).toEqual(["t4", "t3"])
    expect(result.items[1]).toMatchObject({ account: "CARD", amount: "-1", type: "SPEND" })
  })

  test("respects pagination and clamps pageSize to 100", async () => {
    const { listMyTransactions } = await import("../src/modules/transactions/transactions.service.js")
    const page2 = await listMyTransactions(makeApp(), USER_ADDRESS, { page: 2, pageSize: 2 })
    expect(page2.items.map((i) => i.id)).toEqual(["t2", "t1"])
    const big = await listMyTransactions(makeApp(), USER_ADDRESS, { page: 1, pageSize: 1000 })
    expect(big.pageSize).toBe(100)
  })

  test("filters by account", async () => {
    const { listMyTransactions } = await import("../src/modules/transactions/transactions.service.js")
    const card = await listMyTransactions(makeApp(), USER_ADDRESS, { page: 1, pageSize: 20, account: "CARD" })
    expect(card.total).toBe(2)
    expect(card.items.every((i) => i.account === "CARD")).toBe(true)
  })

  test("404 for an unknown user", async () => {
    const { listMyTransactions } = await import("../src/modules/transactions/transactions.service.js")
    await expect(listMyTransactions(makeApp(), "GAL5BE6C7TTJXOZ2OIZXDTJX6K56ZOBUGEFOF3GE2OQUXACSA34N3WSQ", { page: 1, pageSize: 1 })).rejects.toMatchObject({ statusCode: 404 })
  })
})
