import { beforeAll, describe, expect, test } from "bun:test"
import { USER_ADDRESS, makeHttpErrors, makeUser, seedEnv } from "./helpers.js"

beforeAll(seedEnv)

describe("Notifications Service", () => {
  function makeApp(notifications: any[] = []) {
    const store = [...notifications]
    const calls: Record<string, any[]> = { create: [], update: [] }

    const app = {
      prisma: {
        user: {
          findUnique: async (args: { where: { stellarAddress?: string; id?: string } }) => {
            if (args.where.stellarAddress === USER_ADDRESS || args.where.id === "user-1") {
              return { ...makeUser(), id: "user-1", stellarAddress: USER_ADDRESS, email: "user@example.com", notifyEmail: true }
            }
            return null
          },
        },
        notification: {
          findMany: async (args: { where: any; take: number; skip?: number; cursor?: any }) => {
            let res = store.filter((n) => {
              if (args.where.userId && n.userId !== args.where.userId) return false
              if (args.where.readAt === null && n.readAt !== null) return false
              if (args.where.readAt && args.where.readAt.not === null && n.readAt === null) return false
              return true
            })
            return res.slice(0, args.take)
          },
          findUnique: async (args: { where: { id: string } }) => {
            return store.find((n) => n.id === args.where.id) ?? null
          },
          update: async (args: { where: { id: string }; data: any }) => {
            calls.update.push(args)
            const target = store.find((n) => n.id === args.where.id)
            if (!target) throw new Error("not found")
            Object.assign(target, args.data)
            return target
          },
          create: async (args: { data: any }) => {
            calls.create.push(args)
            const created = { id: `notif-${store.length + 1}`, createdAt: new Date(), readAt: null, ...args.data }
            store.push(created)
            return created
          },
        },
      },
      httpErrors: makeHttpErrors(),
    } as any

    return { app, store, calls }
  }

  test("listNotifications returns paginated notifications for the user", async () => {
    const { listNotifications } = await import("../src/modules/notifications/notifications.service.js")
    const { app } = makeApp([
      { id: "n1", userId: "user-1", type: "charge_failed", payload: { amount: "10" }, readAt: null, createdAt: new Date() },
      { id: "n2", userId: "user-1", type: "charged", payload: { amount: "20" }, readAt: new Date(), createdAt: new Date() },
      { id: "n3", userId: "other-user", type: "disbursed", payload: {}, readAt: null, createdAt: new Date() },
    ])

    const result = await listNotifications(app, USER_ADDRESS, { limit: 20 })
    expect(result.notifications).toHaveLength(2)
    expect(result.notifications[0].id).toBe("n1")
    expect(result.notifications[1].id).toBe("n2")
  })

  test("listNotifications filters unread only", async () => {
    const { listNotifications } = await import("../src/modules/notifications/notifications.service.js")
    const { app } = makeApp([
      { id: "n1", userId: "user-1", type: "charge_failed", payload: {}, readAt: null, createdAt: new Date() },
      { id: "n2", userId: "user-1", type: "charged", payload: {}, readAt: new Date(), createdAt: new Date() },
    ])

    const result = await listNotifications(app, USER_ADDRESS, { unread: true, limit: 20 })
    expect(result.notifications).toHaveLength(1)
    expect(result.notifications[0].id).toBe("n1")
  })

  test("markNotificationAsRead marks read for owner and rejects other user", async () => {
    const { markNotificationAsRead } = await import("../src/modules/notifications/notifications.service.js")
    const { app, store } = makeApp([
      { id: "n1", userId: "user-1", type: "charge_failed", payload: {}, readAt: null, createdAt: new Date() },
      { id: "n-other", userId: "other-user", type: "charged", payload: {}, readAt: null, createdAt: new Date() },
    ])

    const res = await markNotificationAsRead(app, USER_ADDRESS, "n1")
    expect(res.readAt).not.toBeNull()
    expect(store.find((n) => n.id === "n1")?.readAt).not.toBeNull()

    // Accessing another user's notification returns 404
    await expect(markNotificationAsRead(app, USER_ADDRESS, "n-other")).rejects.toMatchObject({ statusCode: 404 })
  })

  test("updateProfile updates user email and notifyEmail", async () => {
    const { updateProfile } = await import("../src/modules/users/users.service.js")
    const updatedCalls: any[] = []
    const app = {
      prisma: {
        user: {
          findUnique: async () => ({ ...makeUser(), id: "user-1", stellarAddress: USER_ADDRESS, card: null }),
          update: async (args: any) => {
            updatedCalls.push(args)
            return { ...makeUser(), id: "user-1", stellarAddress: USER_ADDRESS, email: args.data.email, notifyEmail: args.data.notifyEmail, card: null }
          },
        },
      },
      httpErrors: makeHttpErrors(),
    } as any

    const res = await updateProfile(app, USER_ADDRESS, { email: "test@rubbi.xyz", notifyEmail: false })
    expect(res.email).toBe("test@rubbi.xyz")
    expect(res.notifyEmail).toBe(false)
    expect(updatedCalls).toHaveLength(1)
  })
})
