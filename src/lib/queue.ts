import { Queue } from "bullmq"
import { Redis } from "ioredis"

import { env } from "../config/index.js"

export interface CardMovementJobData {
  movementId: string
}

export interface KeeperJobData {
  triggeredAt: string
}

export const queueConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
})

const movementJobOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: 1_000,
} as const

/** Card loads: settle on-chain, then fund the card. */
export const cardLoadQueue = new Queue<CardMovementJobData>("card-load-queue", {
  connection: queueConnection,
  defaultJobOptions: movementJobOptions,
})

/** Card unloads: defund the card, then credit the vault from the treasury. */
export const cardUnloadQueue = new Queue<CardMovementJobData>("card-unload-queue", {
  connection: queueConnection,
  defaultJobOptions: movementJobOptions,
})

/** Keeper runs (charge_batch / disburse_batch), on KEEPER_CRON. */
export const keeperQueue = new Queue<KeeperJobData>("keeper-queue", {
  connection: queueConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
  },
})

export async function closeQueueResources() {
  await Promise.all([cardLoadQueue.close(), cardUnloadQueue.close(), keeperQueue.close(), queueConnection.quit()])
}
