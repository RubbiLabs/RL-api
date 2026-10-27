import { FastifyInstance } from "fastify"

import { transactionSchema } from "../transactions/transactions.routes.js"
import { getDashboardStats } from "./dashboard.service.js"

export async function registerDashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard/stats", {
    onRequest: app.authenticate,
    schema: {
      tags: ["dashboard"],
      description: "Balances, active subscription and schedule counts, and the 10 most recent ledger rows",
      response: {
        200: {
          type: "object",
          properties: {
            walletBalance: { type: "string" },
            cardBalance: { type: "string" },
            activeSubscriptions: { type: "number" },
            pastDueSubscriptions: { type: "number" },
            activeSchedules: { type: "number" },
            incomingSchedules: { type: "number" },
            recentTransactions: { type: "array", items: transactionSchema },
          },
        },
      },
    },
    handler: async (request, reply) => reply.send(await getDashboardStats(app, request.user.sub)),
  })
}
