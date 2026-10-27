import { createHash } from "node:crypto"

import { Prisma } from "@prisma/client"

import type { CardDetails, CardResult, CreateCardParams, ICardIssuer, IssuerCardStatus } from "./index.js"

/**
 * Deterministic fake card issuer for development and tests.
 *
 * - Card ids and last4 are derived from a hash of the user id, so the same
 *   user always gets the same card. Nothing is random.
 * - No PAN and no CVV exist anywhere: `getCardDetails` never returns `pan`.
 * - Balances are kept in memory only, to make fund / defund observable in
 *   tests; the database `cardBalance` is the source of truth.
 */
export class MockCardIssuer implements ICardIssuer {
  readonly name = "MOCK" as const

  private readonly cards = new Map<string, { status: IssuerCardStatus; balance: Prisma.Decimal; userHash: string }>()

  /** Issuer card id for a user; stable across restarts. */
  static cardIdFor(userId: string): string {
    return `mock_${createHash("sha256").update(`rubbi-mock-card:${userId}`).digest("hex").slice(0, 24)}`
  }

  static last4For(userId: string): string {
    const digest = createHash("sha256").update(`rubbi-mock-last4:${userId}`).digest()
    return String(digest.readUInt16BE(0) % 10_000).padStart(4, "0")
  }

  async createVirtualCard(params: CreateCardParams): Promise<CardResult> {
    const id = MockCardIssuer.cardIdFor(params.userId)
    const existing = this.cards.get(id)
    if (!existing) {
      this.cards.set(id, { status: "ACTIVE", balance: new Prisma.Decimal(0), userHash: params.userId })
    }
    return {
      id,
      last4: MockCardIssuer.last4For(params.userId),
      expiryMonth: "12",
      expiryYear: "30",
      status: existing?.status ?? "ACTIVE",
    }
  }

  private card(cardId: string) {
    const card = this.cards.get(cardId)
    if (!card) {
      // Cards created in a previous process are still valid: recreate the
      // in-memory record so fund / defund keep working after a restart.
      const created = { status: "ACTIVE" as IssuerCardStatus, balance: new Prisma.Decimal(0), userHash: "" }
      this.cards.set(cardId, created)
      return created
    }
    return card
  }

  async fundCard(cardId: string, amount: string): Promise<void> {
    const card = this.card(cardId)
    card.balance = card.balance.plus(amount)
  }

  async defundCard(cardId: string, amount: string): Promise<void> {
    const card = this.card(cardId)
    card.balance = card.balance.minus(amount)
  }

  async freezeCard(cardId: string): Promise<void> {
    this.card(cardId).status = "FROZEN"
  }

  async unfreezeCard(cardId: string): Promise<void> {
    this.card(cardId).status = "ACTIVE"
  }

  async getCardDetails(cardId: string): Promise<CardDetails> {
    const card = this.card(cardId)
    return {
      id: cardId,
      last4: card.userHash ? MockCardIssuer.last4For(card.userHash) : "0000",
      expiryMonth: "12",
      expiryYear: "30",
      status: card.status,
      // Deliberately no `pan`: mock cards never expose a card number.
    }
  }

  /** Test helper: the issuer-side balance tracked in memory. */
  balanceOf(cardId: string): string {
    return this.card(cardId).balance.toFixed()
  }
}
