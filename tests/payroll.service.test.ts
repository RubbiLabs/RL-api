import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"

import { makeFakePrisma } from "./fakes/prisma.js"
import { OTHER_ADDRESS, USER_ADDRESS, makeHttpErrors, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

const THIRD = "GAL5BE6C7TTJXOZ2OIZXDTJX6K56ZOBUGEFOF3GE2OQUXACSA34N3WSQ"

function makeApp() {
  const prisma = makeFakePrisma()
  prisma.seed("payrollSchedule", [
    { id: "p1", onChainId: 5n, employer: OTHER_ADDRESS, recipient: USER_ADDRESS, amount: new Prisma.Decimal("150"), period: 2_592_000, label: "Design lead", status: "ACTIVE", nextDueAt: new Date("2026-11-27"), createdAt: new Date("2026-10-01") },
    { id: "p2", onChainId: 6n, employer: OTHER_ADDRESS, recipient: THIRD, amount: new Prisma.Decimal("80"), period: 2_592_000, label: "Support", status: "PAUSED", nextDueAt: new Date("2026-11-27"), createdAt: new Date("2026-10-02") },
    { id: "p3", onChainId: 7n, employer: USER_ADDRESS, recipient: THIRD, amount: new Prisma.Decimal("1"), period: 86_400, label: "Intern", status: "ACTIVE", nextDueAt: new Date("2026-11-27") },
  ])
  return { prisma, httpErrors: makeHttpErrors() } as any
}

describe("payroll mirrors", () => {
  test("listMySchedules returns the caller's schedules as employer, newest first", async () => {
    const { listMySchedules } = await import("../src/modules/payroll/payroll.service.js")
    const result = await listMySchedules(makeApp(), OTHER_ADDRESS)
    expect(result.map((s) => s.onChainId)).toEqual(["6", "5"])
    expect(result[1]).toMatchObject({ label: "Design lead", amount: "150", status: "ACTIVE", recipient: USER_ADDRESS })
  })

  test("listIncomingSchedules returns schedules paying the caller", async () => {
    const { listIncomingSchedules } = await import("../src/modules/payroll/payroll.service.js")
    expect((await listIncomingSchedules(makeApp(), THIRD)).map((s) => s.onChainId)).toEqual(["7", "6"])
  })

  test("getSchedule is readable by employer and recipient only", async () => {
    const { getSchedule } = await import("../src/modules/payroll/payroll.service.js")
    expect(await getSchedule(makeApp(), OTHER_ADDRESS, 5n)).toMatchObject({ label: "Design lead" })
    expect(await getSchedule(makeApp(), USER_ADDRESS, 5n)).toMatchObject({ label: "Design lead" })
    await expect(getSchedule(makeApp(), THIRD, 5n)).rejects.toMatchObject({ statusCode: 404 })
    await expect(getSchedule(makeApp(), OTHER_ADDRESS, 99n)).rejects.toMatchObject({ statusCode: 404 })
  })
})
