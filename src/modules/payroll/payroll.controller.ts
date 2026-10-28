import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import { getSchedule, listIncomingSchedules, listMySchedules } from "./payroll.service.js"

const params = z.object({ scheduleId: z.string().regex(/^\d+$/, "scheduleId must be an integer") })

export function buildPayrollController(app: FastifyInstance) {
  return {
    mine: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await listMySchedules(app, request.user.sub))
    },
    incoming: async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await listIncomingSchedules(app, request.user.sub))
    },
    byId: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = params.safeParse(request.params)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid scheduleId")
      }
      return reply.send(await getSchedule(app, request.user.sub, BigInt(parsed.data.scheduleId)))
    },
  }
}
