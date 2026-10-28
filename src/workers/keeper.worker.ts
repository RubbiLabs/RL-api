import { FastifyInstance } from "fastify"
import { Worker } from "bullmq"

import { env } from "../config/index.js"
import { makeRedisHolds } from "../lib/keeper-holds.js"
import { keeperQueue, queueConnection, type KeeperJobData } from "../lib/queue.js"
import { makeKeeperChain } from "../lib/stellar/keeper-chain.js"
import { runKeeper } from "./keeper.processor.js"

export function startKeeperWorker(app: FastifyInstance) {
  const deps = {
    prisma: app.prisma,
    chain: makeKeeperChain(),
    holds: makeRedisHolds(app.redis),
    log: app.log.child({ component: "keeper" }),
    holdSeconds: env.KEEPER_HOLD_SECONDS,
  }

  const worker = new Worker<KeeperJobData>(
    "keeper-queue",
    async (job) => {
      app.log.info({ jobId: job.id, triggeredAt: job.data.triggeredAt }, "keeper run starting")
      return runKeeper(deps)
    },
    {
      connection: queueConnection,
      // One run at a time: concurrent runs would resubmit the same items.
      concurrency: 1,
    },
  )

  worker.on("failed", (job, error) => {
    app.log.error({ jobId: job?.id, err: error }, "keeper run failed")
  })

  return worker
}

/** Repeatable job on KEEPER_CRON (default: every 10 minutes). */
export async function scheduleKeeper() {
  await keeperQueue.upsertJobScheduler(
    "keeper",
    { pattern: env.KEEPER_CRON },
    { name: "keeper-run", data: { triggeredAt: new Date().toISOString() } },
  )
}
