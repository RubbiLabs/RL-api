import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { usernameBodySchema } from "./users.schema.js"
import { getMe, setUsername } from "./users.service.js"

export function buildUsersController(app: FastifyInstance) {
  return {
    me: async (request: FastifyRequest, reply: FastifyReply) => {
      const result = await getMe(app, request.user.sub)
      return reply.send(result)
    },

    username: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = usernameBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid username")
      }
      const result = await setUsername(app, request.user.sub, parsed.data.username)
      return reply.send(result)
    },
  }
}
