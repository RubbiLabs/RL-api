import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import { listMyTransactions } from "./transactions.service.js"

const querySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  account: z.enum(["WALLET", "CARD"]).optional(),
})

export function buildTransactionsController(app: FastifyInstance) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = querySchema.safeParse(request.query)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid query")
      }
      return reply.send(await listMyTransactions(app, request.user.sub, parsed.data))
    },
  }
}
