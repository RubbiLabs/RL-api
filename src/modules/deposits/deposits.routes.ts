import { FastifyInstance } from "fastify"

import { buildDepositsController } from "./deposits.controller.js"

const depositSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    txHash: { type: "string", description: "Stellar transaction hash (hex)" },
    eventId: { type: "string", description: "RPC event id of the vault `deposit` event" },
    amountRaw: { type: "string", description: "i128 stroops" },
    amount: { type: "string", description: "USDC, 7 decimals" },
    status: { type: "string" },
    ledger: { type: "number" },
    confirmedAt: { type: "string", nullable: true, format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const

const errorResponse = {
  type: "object",
  properties: { statusCode: { type: "number" }, error: { type: "string" }, message: { type: "string" } },
} as const

export async function registerDepositsRoutes(app: FastifyInstance) {
  const controller = buildDepositsController(app)

  app.get("/deposits", {
    onRequest: app.authenticate,
    schema: {
      tags: ["deposits"],
      description: "Vault deposits credited to walletBalance, newest first",
      response: { 200: { type: "array", items: depositSchema }, 404: errorResponse },
    },
    handler: controller.list,
  })

  app.get("/deposits/:txHash", {
    onRequest: app.authenticate,
    schema: {
      tags: ["deposits"],
      description: "A deposit by Stellar transaction hash",
      params: {
        type: "object",
        properties: { txHash: { type: "string", pattern: "^[a-fA-F0-9]{64}$" } },
        required: ["txHash"],
      },
      response: { 200: depositSchema, 404: errorResponse },
    },
    handler: controller.byTxHash,
  })
}
