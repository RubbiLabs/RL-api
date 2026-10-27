import "fastify"

import type { PrismaClient } from "@prisma/client"
import type { Redis } from "ioredis"

import type { ICardIssuer } from "../lib/card-issuer/index.js"

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient
    redis: Redis
    cardIssuer: ICardIssuer
    /** Queue producers for card loads and unloads (mockable in tests). */
    cardMovements: {
      enqueueLoad: (movementId: string) => Promise<void>
      enqueueUnload: (movementId: string) => Promise<void>
    }
    authenticate: (
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply,
    ) => Promise<void>
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string
    }
    user: {
      sub: string
    }
  }
}
