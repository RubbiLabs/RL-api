import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import { getPlanById, listMySubscriptions, listPlans } from "./subscriptions.service.js"

const plansQuery = z.object({ includeInactive: z.coerce.boolean().default(false) })
const planParams = z.object({ planId: z.coerce.number().int().positive() })

export function buildSubscriptionsController(app: FastifyInstance) {
  return {
    plans: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = plansQuery.safeParse(request.query)
      return reply.send(await listPlans(app, query.success ? query.data.includeInactive : false))
    },
    plan: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = planParams.safeParse(request.params)
      if (!params.success) {
        throw app.httpErrors.badRequest("planId must be a positive integer")
      }
      return reply.send(await getPlanById(app, params.data.planId))
    },
    me: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await listMySubscriptions(app, request.user.sub))
    },
  }
}
