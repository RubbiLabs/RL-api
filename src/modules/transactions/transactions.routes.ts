import { FastifyInstance } from "fastify"

import { buildTransactionsController } from "./transactions.controller.js"

export const transactionSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    account: { type: "string", enum: ["WALLET", "CARD"] },
    amount: { type: "string", description: "signed delta applied to `account`" },
    balanceAfter: { type: "string" },
    description: { type: "string" },
    metadata: { type: "object", nullable: true, additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
  },
} as const

export async function registerTransactionsRoutes(app: FastifyInstance) {
  const controller = buildTransactionsController(app)

  app.get("/transactions", {
    onRequest: app.authenticate,
    schema: {
      tags: ["transactions"],
      description: "Paginated ledger rows for both balances (filter with ?account=WALLET|CARD)",
      querystring: {
        type: "object",
        properties: {
          page: { type: "number", minimum: 1, default: 1 },
          pageSize: { type: "number", minimum: 1, maximum: 100, default: 20 },
          account: { type: "string", enum: ["WALLET", "CARD"] },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            page: { type: "number" },
            pageSize: { type: "number" },
            total: { type: "number" },
            items: { type: "array", items: transactionSchema },
          },
        },
      },
    },
    handler: controller.list,
  })
}
