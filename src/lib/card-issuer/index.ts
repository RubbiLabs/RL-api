export type IssuerCardStatus = "ACTIVE" | "FROZEN" | "TERMINATED"

export interface CreateCardParams {
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

export type CardIssuerName = "MOCK" | "SUDO"

export interface ICardIssuer {
  /** Stored on each card so the frontend can show a MOCK badge. */
  readonly name: CardIssuerName
  createVirtualCard(params: CreateCardParams): Promise<CardResult>
  fundCard(cardId: string, amountRubbi: string): Promise<void>
  freezeCard(cardId: string): Promise<void>
  unfreezeCard(cardId: string): Promise<void>
  getCardDetails(cardId: string): Promise<CardDetails>
}
