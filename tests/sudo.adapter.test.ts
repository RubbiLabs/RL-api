import { beforeAll, describe, expect, mock, test } from "bun:test"
import { seedEnv } from "./helpers.js"

beforeAll(seedEnv)

describe("SudoCardIssuer", () => {
  test("constructs with provided options", async () => {
    const { SudoCardIssuer } = await import("../src/lib/card-issuer/sudo.adapter.js")
    const issuer = new SudoCardIssuer({
      apiKey: "test-key",
      baseUrl: "https://api.sudo.africa",
    })
    expect(issuer).toBeDefined()
  })

  test("createVirtualCard throws on network error", async () => {
    const { SudoCardIssuer } = await import("../src/lib/card-issuer/sudo.adapter.js")

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }))

    const issuer = new SudoCardIssuer({
      apiKey: "test-key",
      baseUrl: "https://api.sudo.africa",
    })

    await expect(
      issuer.createVirtualCard({
        userId: "user-1", holderName: "test",
        currency: "USD",
        type: "virtual",
      }),
    ).rejects.toThrow("Sudo API 500")

    globalThis.fetch = originalFetch
  })

  test("fundCard throws on network error", async () => {
    const { SudoCardIssuer } = await import("../src/lib/card-issuer/sudo.adapter.js")

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    }))

    const issuer = new SudoCardIssuer({
      apiKey: "test-key",
      baseUrl: "https://api.sudo.africa",
    })

    await expect(
      issuer.fundCard("card-1", "10.00"),
    ).rejects.toThrow("Sudo API 400")

    globalThis.fetch = originalFetch
  })

  test("normalizes various status strings", async () => {
    const { SudoCardIssuer } = await import("../src/lib/card-issuer/sudo.adapter.js")

    const originalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = mock(async (_url: string, _opts: Record<string, unknown>) => {
      callCount++
      const responses = [
        { status: "ACTIVE" },
        { status: "INACTIVE" },
        { status: "FROZEN" },
        { status: "CANCELED" },
        { status: "UNKNOWN" },
      ]
      const data = responses[callCount - 1] ?? responses[4]
      return {
        ok: true,
        json: async () => ({ data: { _id: "card-x", last4: "9876", expiryMonth: "06", expiryYear: "27", ...data } }),
      }
    })

    const issuer = new SudoCardIssuer({
      apiKey: "key",
      baseUrl: "https://api.sudo.africa",
      defaultCustomerId: "customer_1",
    })

    const active = await issuer.createVirtualCard({ userId: "user-1", holderName: "t", currency: "USD", type: "virtual" })
    expect(active.status).toBe("ACTIVE")

    const inactive = await issuer.createVirtualCard({ userId: "user-1", holderName: "t", currency: "USD", type: "virtual" })
    expect(inactive.status).toBe("FROZEN")

    const frozen = await issuer.createVirtualCard({ userId: "user-1", holderName: "t", currency: "USD", type: "virtual" })
    expect(frozen.status).toBe("FROZEN")

    const canceled = await issuer.createVirtualCard({ userId: "user-1", holderName: "t", currency: "USD", type: "virtual" })
    expect(canceled.status).toBe("TERMINATED")

    const unknown = await issuer.createVirtualCard({ userId: "user-1", holderName: "t", currency: "USD", type: "virtual" })
    expect(unknown.status).toBe("TERMINATED")

    globalThis.fetch = originalFetch
  })
})
