import "./types/index.js"

import fastifyJwt from "@fastify/jwt"
import fastifyRateLimit from "@fastify/rate-limit"
import fastifySwagger from "@fastify/swagger"
import fastifySwaggerUi from "@fastify/swagger-ui"
import Fastify, { FastifyInstance } from "fastify"
import { Worker } from "bullmq"

import { env } from "./config/index.js"
import { createCardIssuer } from "./lib/card-issuer/factory.js"
import { cardLoadQueue, cardUnloadQueue, closeQueueResources } from "./lib/queue.js"
import { contractIds, rpcServer } from "./lib/stellar/client.js"
import { getPlan, getSchedule, getSubscription } from "./lib/stellar/contracts.js"
import { Indexer } from "./lib/stellar/indexer.js"
import { registerAuthRoutes } from "./modules/auth/auth.routes.js"
import { registerCardsRoutes } from "./modules/cards/cards.routes.js"
import { registerDevRoutes, shouldRegisterDevRoutes } from "./modules/dev/dev.routes.js"
import { registerDepositsRoutes } from "./modules/deposits/deposits.routes.js"
import { registerSubscriptionsRoutes } from "./modules/subscriptions/subscriptions.routes.js"
import { registerTransactionsRoutes } from "./modules/transactions/transactions.routes.js"
import { registerUsersRoutes } from "./modules/users/users.routes.js"
import { registerWebhooksRoutes } from "./modules/webhooks/webhooks.routes.js"
import { registerPayrollRoutes } from "./modules/payroll/payroll.routes.js"
import { registerDashboardRoutes } from "./modules/dashboard/dashboard.routes.js"
import { registerStellarRoutes } from "./modules/stellar/stellar.routes.js"
import { prismaPlugin } from "./plugins/prisma.js"
import { redisPlugin } from "./plugins/redis.js"
import { sensiblePlugin } from "./plugins/sensible.js"
import { startCardLoadWorker, startCardUnloadWorker } from "./workers/card-movement.worker.js"
import { scheduleKeeper, startKeeperWorker } from "./workers/keeper.worker.js"

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
    trustProxy: true,
  })

  await app.register(sensiblePlugin)
  await app.register(prismaPlugin)
  await app.register(redisPlugin)

  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  })

  await app.register(fastifyRateLimit, {
    max: 120,
    timeWindow: "1 minute",
  })

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Rubbi API",
        version: "0.2.0",
        description:
          "Rubbi backend on Stellar: SEP-10 auth, chain mirrors (vault, subscriptions, payroll), " +
          "card loads/unloads through the vault, and a mock or Sudo card issuer.",
      },
      tags: [
        { name: "system" },
        { name: "auth", description: "SEP-10 web authentication" },
        { name: "users" },
        { name: "cards", description: "Card, loads and unloads" },
        { name: "deposits" },
        { name: "transactions", description: "Wallet and card ledgers" },
        { name: "subscriptions", description: "Mirror of the subscriptions contract" },
        { name: "payroll", description: "Mirror of the payroll contract" },
        { name: "dashboard" },
        { name: "stellar", description: "Public network configuration" },
        { name: "webhooks", description: "Card issuer callbacks" },
        { name: "dev", description: "Development only" },
      ],
    },
  })

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  })

  app.decorate("cardIssuer", createCardIssuer(env))

  app.decorate("cardMovements", {
    enqueueLoad: async (movementId: string) => {
      await cardLoadQueue.add("card-load", { movementId }, { jobId: movementId })
    },
    enqueueUnload: async (movementId: string) => {
      await cardUnloadQueue.add("card-unload", { movementId }, { jobId: movementId })
    },
  })

  app.decorate("authenticate", async function authenticate(request, reply) {
    try {
      await request.jwtVerify()
    } catch {
      throw reply.unauthorized("Invalid or expired token")
    }
  })

  app.get("/health", {
    schema: {
      tags: ["system"],
      description: "Service health check",
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" },
            service: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
          },
        },
      },
    },
    handler: async () => ({
      status: "ok",
      service: "rubbi-api",
      timestamp: new Date().toISOString(),
    }),
  })

  await app.register(async (api) => {
    await registerAuthRoutes(api)
    await registerUsersRoutes(api)
    await registerCardsRoutes(api)
    await registerDepositsRoutes(api)
    await registerTransactionsRoutes(api)
    await registerSubscriptionsRoutes(api)
    await registerPayrollRoutes(api)
    await registerDashboardRoutes(api)
    await registerStellarRoutes(api)
    await registerWebhooksRoutes(api)
    if (shouldRegisterDevRoutes(env)) {
      await registerDevRoutes(api)
    }
  }, { prefix: "/api/v1" })

  let workers: Worker[] = []
  let indexer: Indexer | null = null

  app.addHook("onReady", async () => {
    workers = [startCardLoadWorker(app), startCardUnloadWorker(app)]

    // Background chain work is not started under NODE_ENV=test; the indexer
    // and keeper are exercised directly by their own tests.
    if (env.NODE_ENV !== "test") {
      indexer = new Indexer({
        prisma: app.prisma,
        rpc: rpcServer,
        reads: { getPlan, getSchedule, getSubscription },
        log: app.log.child({ component: "indexer" }),
        contractIds: [contractIds.vault, contractIds.subscriptions, contractIds.payroll],
        pollIntervalMs: env.INDEXER_POLL_INTERVAL_MS,
        startLedger: env.INDEXER_START_LEDGER,
      })
      indexer.start()

      workers.push(startKeeperWorker(app))
      void scheduleKeeper().catch((error) => {
        app.log.error({ err: error }, "failed to schedule the keeper")
      })
    }
  })

  app.addHook("onClose", async () => {
    indexer?.stop()
    await Promise.all(workers.map((worker) => worker.close()))
    await closeQueueResources()
  })

  return app
}
