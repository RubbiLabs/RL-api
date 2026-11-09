import { FastifyInstance } from "fastify"
import { buildNotificationsController } from "./notifications.controller.js"

const notificationResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    payload: { type: "object", additionalProperties: true },
    readAt: { type: "string", nullable: true },
    createdAt: { type: "string" },
  },
} as const

const listNotificationsResponse = {
  type: "object",
  properties: {
    notifications: {
      type: "array",
      items: notificationResponse,
    },
    nextCursor: { type: "string", nullable: true },
  },
} as const

const errorResponse = {
  type: "object",
  properties: {
    statusCode: { type: "number" },
    error: { type: "string" },
    message: { type: "string" },
  },
} as const

export async function registerNotificationsRoutes(app: FastifyInstance) {
  const controller = buildNotificationsController(app)

  app.get("/notifications", {
    onRequest: app.authenticate,
    schema: {
      tags: ["notifications"],
      description: "List notifications for the authenticated user, newest first",
      querystring: {
        type: "object",
        properties: {
          unread: { type: "string", enum: ["true", "false"] },
          limit: { type: "number", default: 20 },
          cursor: { type: "string" },
        },
      },
      response: { 200: listNotificationsResponse, 404: errorResponse },
    },
    handler: controller.list,
  })

  app.post("/notifications/:id/read", {
    onRequest: app.authenticate,
    schema: {
      tags: ["notifications"],
      description: "Mark a notification as read",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
        },
      },
      response: { 200: notificationResponse, 404: errorResponse },
    },
    handler: controller.markRead,
  })
}
