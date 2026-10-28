import { beforeAll, describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"
import { USER_ADDRESS, makeCard, makeHttpErrors, makeUser, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

describe("getMe", () => {
  test("returns profile with both balances and the card", async () => {
    const { getMe } = await import("../src/modules/users/users.service.js")

    const app = {
      prisma: {
        user: {
          findUnique: async () => ({
            ...makeUser({ walletBalance: new Prisma.Decimal("42.5") }),
            card: makeCard(),
          }),
        },
      },
      httpErrors: makeHttpErrors(),
    } as any

    const result = await getMe(app, USER_ADDRESS)
    expect(result.stellarAddress).toBe(USER_ADDRESS)
    expect(result.walletBalance).toBe("42.5")
    expect(result.cardBalance).toBe("25")
    expect(result.card?.issuer).toBe("MOCK")
    expect(result.card?.last4).toBe("1234")
  })

  test("returns profile without card", async () => {
    const { getMe } = await import("../src/modules/users/users.service.js")
    const app = {
      prisma: { user: { findUnique: async () => ({ ...makeUser(), card: null }) } },
      httpErrors: makeHttpErrors(),
    } as any
    const result = await getMe(app, USER_ADDRESS)
    expect(result.card).toBeNull()
  })

  test("throws 404 when user not found", async () => {
    const { getMe } = await import("../src/modules/users/users.service.js")
    const app = {
      prisma: { user: { findUnique: async () => null } },
      httpErrors: makeHttpErrors(),
    } as any
    await expect(getMe(app, USER_ADDRESS)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe("setUsername", () => {
  function makeApp(opts: { username?: string | null; taken?: boolean; card?: boolean }) {
    const calls: Record<string, unknown[]> = { update: [], cardCreate: [], issuer: [] }
    const base = makeUser({ username: opts.username ?? null, card: null })
    const app = {
      prisma: {
        user: {
          findUnique: async (args: { where: { stellarAddress?: string; username?: string } }) => {
            if (args.where.username) return opts.taken ? { id: "someone-else" } : null
            return { ...base, card: opts.card ? makeCard() : null }
          },
          update: async (args: unknown) => {
            calls.update.push(args)
            return { ...base, username: "levi_o", card: opts.card ? makeCard() : null }
          },
        },
        card: {
          create: async (args: { data: Record<string, unknown> }) => {
            calls.cardCreate.push(args)
            return { id: "card-new", ...args.data }
          },
        },
      },
      cardIssuer: {
        name: "MOCK",
        createVirtualCard: async (params: unknown) => {
          calls.issuer.push(params)
          return { id: "mock-card-1", last4: "4242", expiryMonth: "01", expiryYear: "30", status: "ACTIVE" }
        },
      },
      httpErrors: makeHttpErrors(),
    } as any
    return { app, calls }
  }

  test("sets the username and creates a card on first call", async () => {
    const { setUsername } = await import("../src/modules/users/users.service.js")
    const { app, calls } = makeApp({})

    const result = await setUsername(app, USER_ADDRESS, "levi_o")

    expect(result.username).toBe("levi_o")
    expect(calls.update).toHaveLength(1)
    expect(calls.issuer).toHaveLength(1)
    expect(calls.cardCreate).toHaveLength(1)
    const created = (calls.cardCreate[0] as { data: Record<string, unknown> }).data
    expect(created.issuer).toBe("MOCK")
    expect(created.issuerId).toBe("mock-card-1")
    expect(result.card?.last4).toBe("4242")
  })

  test("does not create a second card", async () => {
    const { setUsername } = await import("../src/modules/users/users.service.js")
    const { app, calls } = makeApp({ card: true })
    await setUsername(app, USER_ADDRESS, "levi_o")
    expect(calls.issuer).toHaveLength(0)
    expect(calls.cardCreate).toHaveLength(0)
  })

  test("rejects a second username for the same address (L11)", async () => {
    const { setUsername } = await import("../src/modules/users/users.service.js")
    const { app, calls } = makeApp({ username: "already" })
    await expect(setUsername(app, USER_ADDRESS, "levi_o")).rejects.toMatchObject({
      statusCode: 409,
      message: "Username already set for this address",
    })
    expect(calls.update).toHaveLength(0)
  })

  test("rejects a username taken by another address", async () => {
    const { setUsername } = await import("../src/modules/users/users.service.js")
    const { app } = makeApp({ taken: true })
    await expect(setUsername(app, USER_ADDRESS, "levi_o")).rejects.toMatchObject({
      statusCode: 409,
      message: "Username is already taken",
    })
  })

  test("maps a concurrent unique violation to 409", async () => {
    const { setUsername } = await import("../src/modules/users/users.service.js")
    const { app } = makeApp({})
    app.prisma.user.update = async () => {
      throw new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
      })
    }
    await expect(setUsername(app, USER_ADDRESS, "levi_o")).rejects.toMatchObject({ statusCode: 409 })
  })

  test("username schema enforces lowercase [a-z0-9_]{3,32}", async () => {
    const { usernameBodySchema } = await import("../src/modules/users/users.schema.js")
    expect(usernameBodySchema.safeParse({ username: "levi_o" }).success).toBe(true)
    expect(usernameBodySchema.safeParse({ username: "Levi" }).success).toBe(false)
    expect(usernameBodySchema.safeParse({ username: "ab" }).success).toBe(false)
    expect(usernameBodySchema.safeParse({ username: "a".repeat(33) }).success).toBe(false)
    expect(usernameBodySchema.safeParse({ username: "le vi" }).success).toBe(false)
  })
})
