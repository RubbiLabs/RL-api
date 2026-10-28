import { FastifyInstance } from "fastify"

import { buildSubscriptionsController } from "./subscriptions.controller.js"

const planSchema = {
  type: "object",
  properties: {
    id: { type: "number" },
    merchant: { type: "string" },
    name: { type: "string" },
    amount: { type: "string", description: "USDC per period" },
    period: { type: "number", description: "seconds" },
    active: { type: "boolean" },
  },
} as const

const subscriptionSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    onChainSubId: { type: "string" },
    subscriber: { type: "string" },
    planId: { type: "number" },
    status: { type: "string", enum: ["ACTIVE", "PAUSED", "PAST_DUE", "CANCELLED"] },
    nextDueAt: { type: "string", format: "date-time" },
    lastChargedAt: { type: "string", format: "date-time", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    plan: { ...planSchema, nullable: true },
  },
} as const

export async function registerSubscriptionsRoutes(app: FastifyInstance) {
  const controller = buildSubscriptionsController(app)

  app.get("/subscriptions/plans", {
    schema: {
      tags: ["subscriptions"],
      description:
        "Plans mirrored from the subscriptions contract (public). Subscribe by approving the USDC SAC " +
        "for amount x N periods and calling `subscribe` from the wallet; the mirror updates on the event.",
      querystring: {
        type: "object",
        properties: { includeInactive: { type: "boolean", default: false } },
      },
      response: { 200: { type: "array", items: planSchema } },
    },
    handler: controller.plans,
  })

  app.get("/subscriptions/plans/:planId", {
    schema: {
      tags: ["subscriptions"],
      description: "One plan by on-chain id (public)",
      params: { type: "object", properties: { planId: { type: "number" } }, required: ["planId"] },
      response: { 200: planSchema },
    },
    handler: controller.plan,
  })

  app.get("/subscriptions/me", {
    onRequest: app.authenticate,
    schema: {
      tags: ["subscriptions"],
      description: "The caller's subscriptions from the mirror, newest first",
      response: { 200: { type: "array", items: subscriptionSchema } },
    },
    handler: controller.me,
  })
}
