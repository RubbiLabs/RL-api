import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

import { getUserBufferedEvents, subscribeUserEvents, type SseEvent } from "../../lib/pubsub.js"

interface StreamQuery {
  token?: string
  lastEventId?: string
}

export async function registerEventsRoutes(app: FastifyInstance) {
  app.get("/events/stream", {
    schema: {
      tags: ["events"],
      summary: "Server-Sent Events live stream",
      description:
        "Subscribes to live user events including card movements, balance changes, " +
        "subscription triggers and payroll disbursements. Supports JWT token in Authorization " +
        "header or ?token= query parameter, and resumption via Last-Event-ID.",
      querystring: {
        type: "object",
        properties: {
          token: { type: "string", description: "JWT access token for EventSource clients" },
          lastEventId: { type: "string", description: "Event ID to replay missed events from" },
        },
      },
    },
    handler: async (request: FastifyRequest<{ Querystring: StreamQuery }>, reply: FastifyReply) => {
      // 1. Authenticate JWT from Authorization header or ?token query param
      let token = ""
      const authHeader = request.headers.authorization
      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7)
      } else if (request.query.token) {
        token = request.query.token
      }

      if (!token) {
        throw app.httpErrors.unauthorized("Authentication token required")
      }

      let payload: { sub?: string; id?: string }
      try {
        payload = app.jwt.verify<{ sub?: string; id?: string }>(token)
      } catch {
        throw app.httpErrors.unauthorized("Invalid or expired token")
      }

      const stellarAddressOrId = payload.sub || payload.id
      if (!stellarAddressOrId) {
        throw app.httpErrors.unauthorized("Invalid token payload")
      }

      // Look up user id from database if sub is stellarAddress
      const user = await app.prisma.user.findFirst({
        where: {
          OR: [{ id: stellarAddressOrId }, { stellarAddress: stellarAddressOrId }],
        },
      })

      if (!user) {
        throw app.httpErrors.unauthorized("User not found")
      }

      const userId = user.id

      // 2. Setup Server-Sent Events headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      })

      const sendEvent = (ev: SseEvent) => {
        const idPart = ev.id ? `id: ${ev.id}\n` : ""
        const eventPart = `event: ${ev.event}\n`
        const dataPart = `data: ${typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data)}\n\n`
        reply.raw.write(`${idPart}${eventPart}${dataPart}`)
      }

      // 3. Replay missed events if Last-Event-ID is provided
      const lastIdHeader = (request.headers["last-event-id"] as string) || request.query.lastEventId
      if (lastIdHeader) {
        const buffered = await getUserBufferedEvents(app.redis, userId, lastIdHeader)
        for (const ev of buffered) {
          sendEvent(ev)
        }
      }

      // Initial connection established event
      sendEvent({
        event: "connected",
        data: { userId, timestamp: new Date().toISOString() },
      })

      // 4. Subscribe to Redis pub/sub for live events
      const unsubscribe = subscribeUserEvents(app.redis, userId, (event) => {
        sendEvent(event)
      })

      // 5. Setup keep-alive heartbeat every 25 seconds
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(": keepalive\n\n")
        } catch {
          // Socket closed
        }
      }, 25000)

      // 6. Clean up on connection close
      request.raw.on("close", () => {
        clearInterval(heartbeat)
        unsubscribe()
      })

      // Return a pending promise so Fastify keeps the HTTP response stream open
      return new Promise<void>(() => {})
    },
  })
}
