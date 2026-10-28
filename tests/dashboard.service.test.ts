import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { OTHER_ADDRESS, USER_ADDRESS, makeHttpErrors, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

describe("getDashboardStats", () => {
  test("aggregates balances, counts and recent rows", async () => {
    const { getDashboardStats } = await import("../src/modules/dashboard/dashboard.service.js")
    const prisma = makeFakePrisma()
    prisma.seed("user", [{ id: "u1", stellarAddress: USER_ADDRESS, walletBalance: new Prisma.Decimal("12.5"), cardBalance: new Prisma.Decimal("3") }])
    prisma.seed("subscription", [
      { onChainSubId: 1n, subscriber: USER_ADDRESS, planId: 1, status: "ACTIVE", nextDueAt: new Date() },
      { onChainSubId: 2n, subscriber: USER_ADDRESS, planId: 1, status: "PAST_DUE", nextDueAt: new Date() },
      { onChainSubId: 3n, subscriber: USER_ADDRESS, planId: 1, status: "CANCELLED", nextDueAt: new Date() },
      { onChainSubId: 4n, subscriber: OTHER_ADDRESS, planId: 1, status: "ACTIVE", nextDueAt: new Date() },
    ])
    prisma.seed("payrollSchedule", [
      { onChainId: 1n, employer: USER_ADDRESS, recipient: OTHER_ADDRESS, amount: 1, period: 1, label: "a", status: "ACTIVE", nextDueAt: new Date() },
      { onChainId: 2n, employer: USER_ADDRESS, recipient: OTHER_ADDRESS, amount: 1, period: 1, label: "b", status: "CANCELLED", nextDueAt: new Date() },
      { onChainId: 3n, employer: OTHER_ADDRESS, recipient: USER_ADDRESS, amount: 1, period: 1, label: "c", status: "ACTIVE", nextDueAt: new Date() },
    ])
    prisma.seed(
      "transaction",
      Array.from({ length: 12 }, (_, i) => ({
        id: `t${i}`, userId: "u1", type: "DEPOSIT", account: "WALLET", amount: new Prisma.Decimal(1), balanceAfter: new Prisma.Decimal(i), description: "d", createdAt: new Date(2026, 0, i + 1),
      })),
    )

    const stats = await getDashboardStats({ prisma, httpErrors: makeHttpErrors() } as any, USER_ADDRESS)
    expect(stats).toMatchObject({
      walletBalance: "12.5",
      cardBalance: "3",
      activeSubscriptions: 1,
      pastDueSubscriptions: 1,
      activeSchedules: 1,
      incomingSchedules: 1,
    })
    expect(stats.recentTransactions).toHaveLength(10)
    expect(stats.recentTransactions[0]!.id).toBe("t11")
  })
})
