import fastifyPlugin from "fastify-plugin"
import { Redis } from "ioredis"

import { env } from "../config/index.js"

export const redisPlugin = fastifyPlugin(async (app) => {
  if (!env.REDIS_URL) {
    return
  }
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  })

  app.decorate("redis", redis)

  app.addHook("onClose", async () => {
    await redis.quit()
  })
})
