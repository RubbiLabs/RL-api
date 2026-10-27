import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import { getDepositByHash, listMyDeposits } from "./deposits.service.js"

const paramsSchema = z.object({
  txHash: z.string().regex(/^[a-fA-F0-9]{64}$/, "txHash must be a 64-character hex Stellar transaction hash"),
})

export function buildDepositsController(app: FastifyInstance) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await listMyDeposits(app, request.user.sub))
    },
    byTxHash: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = paramsSchema.safeParse(request.params)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid txHash")
      }
      return reply.send(await getDepositByHash(app, request.user.sub, parsed.data.txHash.toLowerCase()))
    },
  }
}
