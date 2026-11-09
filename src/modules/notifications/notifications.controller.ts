import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { listNotificationsQuerySchema, notificationParamSchema } from "./notifications.schema.js"
import { listNotifications, markNotificationAsRead } from "./notifications.service.js"

export function buildNotificationsController(app: FastifyInstance) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = listNotificationsQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "Invalid query parameters")
      }
      const result = await listNotifications(app, request.user.sub, parsed.data)
      return reply.send(result)
    },

    markRead: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = notificationParamSchema.safeParse(request.params)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "Invalid notification id")
      }
      const result = await markNotificationAsRead(app, request.user.sub, parsed.data.id)
      return reply.send(result)
    },
  }
}
