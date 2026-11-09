import { beforeAll, describe, expect, test } from "bun:test"
import { FastifyInstance } from "fastify"
import Fastify from "fastify"
import fastifyJwt from "@fastify/jwt"
import fastifySensible from "@fastify/sensible"

import { makeFakePrisma } from "./fakes/prisma.js"
import { USER_ADDRESS, seedEnv } from "./helpers.js"
import { publishUserEvent, getUserBufferedEvents } from "../src/lib/pubsub.js"
import { registerEventsRoutes } from "../src/modules/events/events.routes.js"

beforeAll(seedEnv)

describe("GET /events/stream", () => {
  async function makeTestApp() {
    const app = Fastify({ logger: false })
    const prisma = makeFakePrisma()
    prisma.seed("user", [
      { id: "u1", stellarAddress: USER_ADDRESS },
      { id: "u2", stellarAddress: "GBOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    ])

    await app.register(fastifySensible)
    await app.register(fastifyJwt, { secret: "test-secret" })
    app.decorate("prisma", prisma)
    app.decorate("redis", undefined)

    await registerEventsRoutes(app)
    return { app, prisma }
  }

  test("rejects request without token with 401", async () => {
    const { app } = await makeTestApp()
    const res = await app.inject({
      method: "GET",
      url: "/events/stream",
    })
    expect(res.statusCode).toBe(401)
  })

  test("rejects request with invalid token with 401", async () => {
    const { app } = await makeTestApp()
    const res = await app.inject({
      method: "GET",
      url: "/events/stream?token=invalid.token.here",
    })
    expect(res.statusCode).toBe(401)
  })

  test("authenticates valid token via query parameter", async () => {
    const { app } = await makeTestApp()
    const token = app.jwt.sign({ sub: USER_ADDRESS })

    // Inject request with short timeout / abort simulation
    const res = await app.inject({
      method: "GET",
      url: `/events/stream?token=${token}`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toBe("text/event-stream")
    expect(res.body).toContain("event: connected")
  })

  test("authenticates valid token via Authorization header", async () => {
    const { app } = await makeTestApp()
    const token = app.jwt.sign({ sub: "u1" })

    const res = await app.inject({
      method: "GET",
      url: "/events/stream",
      headers: {
        authorization: `Bearer ${token}`,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain("event: connected")
  })
})
