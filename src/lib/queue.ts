import { Queue } from "bullmq"
import { Redis } from "ioredis"

import { env } from "../config/index.js"

export interface TopupJobData {
  userId: string
  depositId: string
  amountRubbi: string
}

export const queueConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
})

export const topupQueue = new Queue<TopupJobData>("topup-queue", {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_500 },
    removeOnComplete: 200,
    removeOnFail: 500,
  },
})

export async function closeQueueResources() {
  await Promise.all([topupQueue.close(), queueConnection.quit()])
}
