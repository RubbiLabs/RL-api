export type IssuerCardStatus = "ACTIVE" | "FROZEN" | "TERMINATED"

export type CardIssuerName = "MOCK" | "SUDO"

export interface CreateCardParams {
  /** Rubbi user id; the mock derives deterministic card data from it. */
  userId: string
  holderName: string
  currency: "USD"
  type: "virtual"
}

export interface CardResult {
  id: string
  last4: string
  expiryMonth: string
  expiryYear: string
  status: IssuerCardStatus
}

export interface CardDetails {
  id: string
  last4: string
  expiryMonth: string
  expiryYear: string
  status: IssuerCardStatus
  pan?: string
}

export interface ICardIssuer {
  /** Stored on each card so the frontend can show a MOCK badge. */
  readonly name: CardIssuerName
  createVirtualCard(params: CreateCardParams): Promise<CardResult>
  /**
   * Adds `amount` (decimal USD string) to the card's spendable balance.
   * `reference` identifies the movement so a retried call is applied once.
   */
  fundCard(cardId: string, amount: string, reference: string): Promise<void>
  /** Removes `amount` (decimal USD string) from the card's spendable balance; same idempotency rule. */
  defundCard(cardId: string, amount: string, reference: string): Promise<void>
  freezeCard(cardId: string): Promise<void>
  unfreezeCard(cardId: string): Promise<void>
  getCardDetails(cardId: string): Promise<CardDetails>
}
