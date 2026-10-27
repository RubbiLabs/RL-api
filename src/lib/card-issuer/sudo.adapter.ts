import {
  CardDetails,
  CardResult,
  CreateCardParams,
  ICardIssuer,
  IssuerCardStatus,
} from "./index.js"

interface SudoAdapterOptions {
  apiKey: string
  baseUrl: string
  defaultCustomerId?: string
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[]
interface JsonObject {
  [key: string]: JsonValue
}

function toIssuerStatus(status: string): IssuerCardStatus {
  const normalized = status.toUpperCase()
  if (normalized === "ACTIVE") return "ACTIVE"
  if (normalized === "INACTIVE" || normalized === "FROZEN") return "FROZEN"
  if (normalized === "CANCELED" || normalized === "TERMINATED") return "TERMINATED"
  return "TERMINATED"
}

export class SudoCardIssuer implements ICardIssuer {
  readonly name = "SUDO" as const
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly defaultCustomerId?: string

  constructor(options: SudoAdapterOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.defaultCustomerId = options.defaultCustomerId
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: JsonObject,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Sudo API ${response.status}: ${errorBody}`)
    }

    return (await response.json()) as T
  }

  async createVirtualCard(params: CreateCardParams): Promise<CardResult> {
    const normalize = (data: {
      data?: {
        _id?: string
        id?: string
        last4?: string
        maskedPan?: string
        expiryMonth?: string
        expiryYear?: string
        status: string
      }
    }): CardResult => {
      const card = data.data
      const cardId = card?._id ?? card?.id
      const last4 = card?.last4 ?? card?.maskedPan?.slice(-4)

      if (!card || !cardId || !card.expiryMonth || !card.expiryYear || !last4) {
        throw new Error("Sudo API did not return card data")
      }

      return {
        id: cardId,
        last4,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        status: toIssuerStatus(card.status),
      }
    }

    if (this.defaultCustomerId) {
      try {
        const payload = {
          customerId: this.defaultCustomerId,
          type: params.type,
          currency: params.currency,
          status: "active",
          metadata: JSON.stringify({
            holderName: params.holderName,
          }),
        }

        const modern = await this.request<{
          data?: {
            _id?: string
            id?: string
            last4?: string
            maskedPan?: string
            expiryMonth?: string
            expiryYear?: string
            status: string
          }
        }>("POST", "/cards", payload)

        return normalize(modern)
      } catch {
        // Fallback below supports deployments still using /cards/virtual shape.
      }
    }

    const legacy = await this.request<{
      data?: {
        _id?: string
        id?: string
        last4?: string
        maskedPan?: string
        expiryMonth?: string
        expiryYear?: string
        status: string
      }
    }>("POST", "/cards/virtual", {
      type: params.type,
      currency: params.currency,
      holderName: params.holderName,
    })

    return normalize(legacy)
  }

  async fundCard(cardId: string, amountRubbi: string): Promise<void> {
    await this.request("POST", `/cards/${cardId}/fund`, {
      amount: amountRubbi,
      currency: "USD",
    })
  }

  async freezeCard(cardId: string): Promise<void> {
    try {
      await this.request("PUT", `/cards/${cardId}`, {
        status: "inactive",
      })
    } catch {
      await this.request("PUT", `/cards/${cardId}/freeze`)
    }
  }

  async unfreezeCard(cardId: string): Promise<void> {
    try {
      await this.request("PUT", `/cards/${cardId}`, {
        status: "active",
      })
    } catch {
      await this.request("PUT", `/cards/${cardId}/unfreeze`)
    }
  }

  async getCardDetails(cardId: string): Promise<CardDetails> {
    const data = await this.request<{
      data?: {
        _id?: string
        id?: string
        last4?: string
        maskedPan?: string
        expiryMonth?: string
        expiryYear?: string
        status: string
        pan?: string
      }
    }>("GET", `/cards/${cardId}`)

    const card = data.data
    const resolvedId = card?._id ?? card?.id
    const last4 = card?.last4 ?? card?.maskedPan?.slice(-4)

    if (!card || !resolvedId || !card.expiryMonth || !card.expiryYear || !last4) {
      throw new Error("Sudo API did not return card details")
    }

    return {
      id: resolvedId,
      last4,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      status: toIssuerStatus(card.status),
      pan: card.pan,
    }
  }
}
