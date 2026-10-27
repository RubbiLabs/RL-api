import { beforeAll, describe, expect, test } from "bun:test"
import { seedEnv } from "./helpers.js"

beforeAll(seedEnv)

describe("MockCardIssuer", () => {
  test("is named MOCK and issues deterministic cards from the user id", async () => {
    const { MockCardIssuer } = await import("../src/lib/card-issuer/mock.adapter.js")
    const issuer = new MockCardIssuer()
    expect(issuer.name).toBe("MOCK")

    const a = await issuer.createVirtualCard({ userId: "user-a", holderName: "a", currency: "USD", type: "virtual" })
    const again = await new MockCardIssuer().createVirtualCard({ userId: "user-a", holderName: "x", currency: "USD", type: "virtual" })
    const b = await issuer.createVirtualCard({ userId: "user-b", holderName: "b", currency: "USD", type: "virtual" })

    expect(a).toEqual(again)
    expect(a.id).toMatch(/^mock_[0-9a-f]{24}$/)
    expect(a.last4).toMatch(/^\d{4}$/)
    expect(a.id).not.toBe(b.id)
    expect(a.status).toBe("ACTIVE")
  })

  test("never returns a PAN or CVV", async () => {
    const { MockCardIssuer } = await import("../src/lib/card-issuer/mock.adapter.js")
    const issuer = new MockCardIssuer()
    const card = await issuer.createVirtualCard({ userId: "user-a", holderName: "a", currency: "USD", type: "virtual" })
    const details = await issuer.getCardDetails(card.id)
    expect(details.pan).toBeUndefined()
    expect(JSON.stringify(details)).not.toMatch(/pan|cvv/i)
    expect(details.last4).toBe(card.last4)
  })

  test("fund, defund, freeze and unfreeze are observable", async () => {
    const { MockCardIssuer } = await import("../src/lib/card-issuer/mock.adapter.js")
    const issuer = new MockCardIssuer()
    const card = await issuer.createVirtualCard({ userId: "user-a", holderName: "a", currency: "USD", type: "virtual" })

    await issuer.fundCard(card.id, "12.5")
    await issuer.defundCard(card.id, "2.5")
    expect(issuer.balanceOf(card.id)).toBe("10")

    await issuer.freezeCard(card.id)
    expect((await issuer.getCardDetails(card.id)).status).toBe("FROZEN")
    await issuer.unfreezeCard(card.id)
    expect((await issuer.getCardDetails(card.id)).status).toBe("ACTIVE")
  })

  test("the factory picks the issuer from CARD_ISSUER", async () => {
    const { createCardIssuer } = await import("../src/lib/card-issuer/factory.js")
    expect(createCardIssuer({ CARD_ISSUER: "mock", SUDO_BASE_URL: "https://api.sudo.africa" } as any).name).toBe("MOCK")
    expect(
      createCardIssuer({ CARD_ISSUER: "sudo", SUDO_API_KEY: "k", SUDO_BASE_URL: "https://api.sudo.africa" } as any).name,
    ).toBe("SUDO")
    expect(() => createCardIssuer({ CARD_ISSUER: "sudo", SUDO_BASE_URL: "https://api.sudo.africa" } as any)).toThrow(
      "requires SUDO_API_KEY",
    )
  })
})
