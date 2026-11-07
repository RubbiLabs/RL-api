import { FastifyInstance } from "fastify"

export interface RateLimiterStore {
  incr(key: string, ttlSeconds: number): Promise<{ count: number; ttl: number }>
}

export class MemoryRateLimitStore implements RateLimiterStore {
  private store = new Map<string, { count: number; resetAt: number }>()

  async incr(key: string, ttlSeconds: number): Promise<{ count: number; ttl: number }> {
    const now = Date.now()
    const entry = this.store.get(key)
    if (!entry || now >= entry.resetAt) {
      const resetAt = now + ttlSeconds * 1000
      this.store.set(key, { count: 1, resetAt })
      return { count: 1, ttl: ttlSeconds }
    }
    entry.count += 1
    const ttl = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    return { count: entry.count, ttl }
  }

  clear() {
    this.store.clear()
  }
}

export class RedisRateLimitStore implements RateLimiterStore {
  constructor(private redis: any) {}

  async incr(key: string, ttlSeconds: number): Promise<{ count: number; ttl: number }> {
    if (typeof this.redis.pipeline === "function") {
      const p = this.redis.pipeline()
      p.incr(key)
      p.ttl(key)
      const results = await p.exec()
      const count = Number(results[0][1])
      let ttl = Number(results[1][1])
      if (ttl === -1 || ttl === -2) {
        await this.redis.expire(key, ttlSeconds)
        ttl = ttlSeconds
      }
      return { count, ttl: Math.max(1, ttl) }
    }
    if (typeof this.redis.incr === "function") {
      const count = Number(await this.redis.incr(key))
      let ttl = Number(await this.redis.ttl(key))
      if (ttl === -1 || ttl === -2) {
        await this.redis.expire(key, ttlSeconds)
        ttl = ttlSeconds
      }
      return { count, ttl: Math.max(1, ttl) }
    }
    // Fallback for mock redis supporting get/set
    const now = Math.floor(Date.now() / 1000)
    const raw = await this.redis.get(key)
    let data: { count: number; expiresAt: number }
    if (!raw) {
      data = { count: 1, expiresAt: now + ttlSeconds }
    } else {
      try {
        data = JSON.parse(raw)
        if (now >= data.expiresAt) {
          data = { count: 1, expiresAt: now + ttlSeconds }
        } else {
          data.count += 1
        }
      } catch {
        data = { count: Number(raw) + 1, expiresAt: now + ttlSeconds }
      }
    }
    await this.redis.set(key, JSON.stringify(data))
    return { count: data.count, ttl: Math.max(1, data.expiresAt - now) }
  }
}

let defaultMemoryStore: MemoryRateLimitStore | null = null

export function getAccountRateLimitStore(app?: FastifyInstance): RateLimiterStore {
  if (app && (app as any).accountRateLimitStore) {
    return (app as any).accountRateLimitStore
  }
  if (app && (app as any).redis) {
    return new RedisRateLimitStore((app as any).redis)
  }
  if (!defaultMemoryStore) {
    defaultMemoryStore = new MemoryRateLimitStore()
  }
  return defaultMemoryStore
}
