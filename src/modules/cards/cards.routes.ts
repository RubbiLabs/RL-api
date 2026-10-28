import { FastifyInstance } from "fastify"

import { buildCardsController } from "./cards.controller.js"

const errorResponse = {
  type: "object",
  properties: {
    statusCode: { type: "number" },
    error: { type: "string" },
    message: { type: "string" },
  },
} as const

const movementResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    direction: { type: "string", enum: ["LOAD", "UNLOAD"] },
    amount: { type: "string" },
    status: { type: "string", enum: ["PENDING", "SETTLED", "PENDING_TREASURY", "COMPLETED", "FAILED"] },
    reference: { type: "string", description: "sha256 of the movement id; the on-chain idempotency key" },
    txHash: { type: "string", nullable: true },
    failureReason: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    settledAt: { type: "string", format: "date-time", nullable: true },
    completedAt: { type: "string", format: "date-time", nullable: true },
  },
} as const

const moveBody = {
  type: "object",
  required: ["amount"],
  properties: {
    amount: { type: "string", description: "USDC amount, e.g. \"25\" or \"12.5\"" },
  },
} as const

export async function registerCardsRoutes(app: FastifyInstance) {
  const controller = buildCardsController(app)

  app.get("/cards/me", {
    onRequest: app.authenticate,
    schema: {
      tags: ["cards"],
      description: "Current user's card and both balances",
      response: {
        200: {
          type: "object",
          properties: {
            id: { type: "string" },
            issuer: { type: "string", description: "MOCK or SUDO" },
            issuerId: { type: "string" },
            last4: { type: "string" },
            expiryMonth: { type: "string" },
            expiryYear: { type: "string" },
            status: { type: "string" },
            cardBalance: { type: "string" },
            walletBalance: { type: "string" },
          },
        },
        404: errorResponse,
      },
    },
    handler: controller.me,
  })

  app.post("/cards/freeze", {
    onRequest: app.authenticate,
    schema: {
      tags: ["cards"],
      description: "Freeze current user card",
      body: { type: "object", properties: { reason: { type: "string", minLength: 1, maxLength: 140 } } },
      response: { 200: { type: "object", properties: { status: { type: "string" } } } },
    },
    handler: controller.freeze,
  })

  app.post("/cards/unfreeze", {
    onRequest: app.authenticate,
    schema: {
      tags: ["cards"],
      description: "Unfreeze current user card",
      body: { type: "object", properties: { reason: { type: "string", minLength: 1, maxLength: 140 } } },
      response: { 200: { type: "object", properties: { status: { type: "string" } } } },
    },
    handler: controller.unfreeze,
  })

  app.get("/cards/me/number", {
    onRequest: app.authenticate,
    schema: {
      tags: ["cards"],
      description: "Reveal the full PAN from the issuer (always null for MOCK cards)",
      response: {
        200: {
          type: "object",
          properties: {
            cardId: { type: "string" },
            issuer: { type: "string" },
            pan: { type: "string", nullable: true },
            last4: { type: "string" },
            expiryMonth: { type: "string" },
            expiryYear: { type: "string" },
            status: { type: "string" },
          },
        },
        404: errorResponse,
      },
    },
    handler: controller.reveal,
  })

  app.post("/cards/load", {
    onRequest: app.authenticate,
    schema: {
      tags: ["cards"],
      summary: "Load the card from the vault",
      description:
        "Moves `amount` USDC from the user's vault balance onto the card. Rejected when amount exceeds " +
        "walletBalance (minus loads in flight). Processing is asynchronous: the operator settles the " +
        "amount on-chain (settle_card_spend), then the issuer funds the card and cardBalance is credited. " +
        "Poll GET /cards/movements for the status.",
      body: moveBody,
      response: { 202: movementResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse },
    },
    handler: controller.load,
  })

  app.post("/cards/unload", {
    onRequest: app.authenticate,
    schema: {
      tags: ["cards"],
      summary: "Unload the card back to the vault",
      description:
        "Moves `amount` USDC from the card back to the user's vault. Rejected when amount exceeds " +
        "cardBalance (minus unloads in flight). The issuer defunds the card and cardBalance is debited, " +
        "then the treasury credits the vault (credit_refund). Without TREASURY_SECRET the movement waits " +
        "in PENDING_TREASURY until an operator processes it.",
      body: moveBody,
      response: { 202: movementResponse, 400: errorResponse, 404: errorResponse },
    },
    handler: controller.unload,
  })

  app.get("/cards/movements", {
    onRequest: app.authenticate,
    schema: {
      tags: ["cards"],
      description: "Card loads and unloads, newest first",
      response: { 200: { type: "array", items: movementResponse }, 404: errorResponse },
    },
    handler: controller.movements,
  })
}
