import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { cardActionSchema, cardMoveBodySchema } from "./cards.schema.js"
import {
  freezeMyCard,
  getMyCard,
  listMyCardMovements,
  loadCard,
  revealMyCardNumber,
  unfreezeMyCard,
  unloadCard,
} from "./cards.service.js"

export function buildCardsController(app: FastifyInstance) {
  const parseMove = (body: unknown) => {
    const parsed = cardMoveBodySchema.safeParse(body)
    if (!parsed.success) {
      throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid amount")
    }
    return parsed.data
  }

  return {
    me: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await getMyCard(app, request.user.sub))
    },
    freeze: async (request: FastifyRequest, reply: FastifyReply) => {
      cardActionSchema.parse(request.body ?? {})
      return reply.send(await freezeMyCard(app, request.user.sub))
    },
    unfreeze: async (request: FastifyRequest, reply: FastifyReply) => {
      cardActionSchema.parse(request.body ?? {})
      return reply.send(await unfreezeMyCard(app, request.user.sub))
    },
    reveal: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await revealMyCardNumber(app, request.user.sub))
    },
    load: async (request: FastifyRequest, reply: FastifyReply) => {
      const { amount } = parseMove(request.body)
      return reply.code(202).send(await loadCard(app, request.user.sub, amount))
    },
    unload: async (request: FastifyRequest, reply: FastifyReply) => {
      const { amount } = parseMove(request.body)
      return reply.code(202).send(await unloadCard(app, request.user.sub, amount))
    },
    movements: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await listMyCardMovements(app, request.user.sub))
    },
  }
}
