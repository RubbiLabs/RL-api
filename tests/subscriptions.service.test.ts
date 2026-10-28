import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { OTHER_ADDRESS, USER_ADDRESS, makeHttpErrors, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

function makeApp() {
  const prisma = makeFakePrisma()
  prisma.seed("subscriptionPlan", [
    { id: 1, merchant: OTHER_ADDRESS, name: "Pro", amount: new Prisma.Decimal("9.9"), period: 2_592_000, active: true },
    { id: 2, merchant: OTHER_ADDRESS, name: "Old", amount: new Prisma.Decimal("1"), period: 86_400, active: false },
  ])
  prisma.seed("subscription", [
    { id: "s1", onChainSubId: 7n, subscriber: USER_ADDRESS, planId: 1, status: "ACTIVE", nextDueAt: new Date("2026-11-27"), createdAt: new Date("2026-10-01") },
    { id: "s2", onChainSubId: 8n, subscriber: USER_ADDRESS, planId: 2, status: "CANCELLED", nextDueAt: new Date("2026-11-27"), createdAt: new Date("2026-10-02") },
    { id: "s3", onChainSubId: 9n, subscriber: OTHER_ADDRESS, planId: 1, status: "ACTIVE", nextDueAt: new Date("2026-11-27") },
  ])
  return { prisma, httpErrors: makeHttpErrors() } as any
}

describe("listPlans", () => {
  test("returns active plans by default, all with includeInactive", async () => {
    const { listPlans } = await import("../src/modules/subscriptions/subscriptions.service.js")
    const active = await listPlans(makeApp())
    expect(active).toEqual([{ id: 1, merchant: OTHER_ADDRESS, name: "Pro", amount: "9.9", period: 2_592_000, active: true }])
    expect((await listPlans(makeApp(), true)).map((p) => p.id)).toEqual([1, 2])
  })

  test("getPlanById 404s for unknown plans", async () => {
    const { getPlanById } = await import("../src/modules/subscriptions/subscriptions.service.js")
    expect(await getPlanById(makeApp(), 2)).toMatchObject({ name: "Old", active: false })
    await expect(getPlanById(makeApp(), 99)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe("listMySubscriptions", () => {
  test("returns only the caller's subscriptions, newest first, with plans and string ids", async () => {
    const { listMySubscriptions } = await import("../src/modules/subscriptions/subscriptions.service.js")
    const result = await listMySubscriptions(makeApp(), USER_ADDRESS)
    expect(result.map((s) => s.onChainSubId)).toEqual(["8", "7"])
    expect(result[1]).toMatchObject({ status: "ACTIVE", planId: 1, plan: { name: "Pro", amount: "9.9" } })
  })

  test("addresses are matched verbatim (case-sensitive)", async () => {
    const { listMySubscriptions } = await import("../src/modules/subscriptions/subscriptions.service.js")
    expect(await listMySubscriptions(makeApp(), USER_ADDRESS.toLowerCase())).toEqual([])
  })
})
