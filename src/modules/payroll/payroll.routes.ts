import { FastifyInstance } from "fastify"

import { buildPayrollController } from "./payroll.controller.js"

const scheduleSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    onChainId: { type: "string" },
    employer: { type: "string" },
    recipient: { type: "string" },
    amount: { type: "string", description: "USDC per period" },
    period: { type: "number", description: "seconds" },
    label: { type: "string" },
    status: { type: "string", enum: ["ACTIVE", "PAUSED", "CANCELLED"] },
    nextDueAt: { type: "string", format: "date-time" },
    lastDisbursedAt: { type: "string", format: "date-time", nullable: true },
    createdAt: { type: "string", format: "date-time" },
  },
} as const

const errorResponse = {
  type: "object",
  properties: { statusCode: { type: "number" }, error: { type: "string" }, message: { type: "string" } },
} as const

export async function registerPayrollRoutes(app: FastifyInstance) {
  const controller = buildPayrollController(app)

  app.get("/payroll/schedules", {
    onRequest: app.authenticate,
    schema: {
      tags: ["payroll"],
      description: "Schedules the caller created as employer (mirror of the payroll contract)",
      response: { 200: { type: "array", items: scheduleSchema } },
    },
    handler: controller.mine,
  })

  app.get("/payroll/schedules/incoming", {
    onRequest: app.authenticate,
    schema: {
      tags: ["payroll"],
      description: "Schedules that pay the caller",
      response: { 200: { type: "array", items: scheduleSchema } },
    },
    handler: controller.incoming,
  })

  app.get("/payroll/schedules/:scheduleId", {
    onRequest: app.authenticate,
    schema: {
      tags: ["payroll"],
      description: "One schedule by on-chain id (employer or recipient only)",
      params: { type: "object", properties: { scheduleId: { type: "string" } }, required: ["scheduleId"] },
      response: { 200: scheduleSchema, 404: errorResponse },
    },
    handler: controller.byId,
  })
}
