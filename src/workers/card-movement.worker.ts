import { FastifyInstance } from "fastify"
import { Worker } from "bullmq"

import { cardUnloadQueue, queueConnection, type CardMovementJobData } from "../lib/queue.js"
import { makeVaultClient } from "../lib/stellar/vault.js"
import { compensateFailedLoad, processLoad, processUnload, type MovementDeps } from "./card-movement.processor.js"

function deps(app: FastifyInstance): MovementDeps {
  return {
    prisma: app.prisma,
    vault: makeVaultClient(),
    cardIssuer: app.cardIssuer,
    log: app.log.child({ component: "card-movements" }),
    enqueueUnload: async (movementId) => {
      await cardUnloadQueue.add("card-unload", { movementId }, { jobId: movementId })
    },
  }
}

export function startCardLoadWorker(app: FastifyInstance) {
  const d = deps(app)
  const worker = new Worker<CardMovementJobData>(
    "card-load-queue",
    async (job) => ({ status: await processLoad(d, job.data.movementId) }),
    { connection: queueConnection, concurrency: 4 },
  )

  worker.on("failed", async (job, error) => {
    app.log.error({ jobId: job?.id, err: error }, "card load job failed")
    if (!job) return
    const maxAttempts = job.opts.attempts ?? 1
    if (job.attemptsMade < maxAttempts) return
    try {
      await compensateFailedLoad(d, job.data.movementId, error.message)
    } catch (compensationError) {
      app.log.error({ jobId: job.id, err: compensationError }, "card load compensation failed; manual action needed")
    }
  })

  return worker
}

export function startCardUnloadWorker(app: FastifyInstance) {
  const d = deps(app)
  const worker = new Worker<CardMovementJobData>(
    "card-unload-queue",
    async (job) => ({ status: await processUnload(d, job.data.movementId) }),
    { connection: queueConnection, concurrency: 4 },
  )

  worker.on("failed", (job, error) => {
    app.log.error({ jobId: job?.id, err: error }, "card unload job failed")
  })

  return worker
}
