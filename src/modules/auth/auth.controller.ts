import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { challengeQuerySchema, tokenBodySchema } from "./auth.schema.js"
import { buildChallenge, verifyChallengeAndIssueToken } from "./auth.service.js"

export function buildAuthController(app: FastifyInstance) {
  return {
    challenge: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = challengeQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid account")
      }
      return reply.send(buildChallenge(parsed.data.account))
    },

    token: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = tokenBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid body")
      }
      const result = await verifyChallengeAndIssueToken(app, parsed.data.transaction)
      return reply.send(result)
    },
  }
}
