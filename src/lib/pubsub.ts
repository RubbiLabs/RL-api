import { randomUUID } from "node:crypto"
import type { Redis } from "ioredis"

export interface SseEvent<T = unknown> {
  id?: string
  event: string
  data: T
  createdAt?: string
}

const BUFFER_KEY_PREFIX = "events:buffer:"
const CHANNEL_KEY_PREFIX = "events:channel:"
const MAX_BUFFER_SIZE = 100
const BUFFER_TTL_SECONDS = 3600 // 1 hour

/**
 * Publishes an event for a user to Redis pub/sub and buffers it for Last-Event-ID replay.
 */
export async function publishUserEvent<T>(
  redis: Redis | undefined,
  userId: string,
  event: SseEvent<T>,
): Promise<string> {
  const id = event.id ?? `${Date.now()}-${randomUUID().slice(0, 8)}`
  const payload: SseEvent<T> = {
    ...event,
    id,
    createdAt: event.createdAt ?? new Date().toISOString(),
  }

  if (!redis) {
    return id
  }

  const json = JSON.stringify(payload)
  const bufferKey = `${BUFFER_KEY_PREFIX}${userId}`
  const channelKey = `${CHANNEL_KEY_PREFIX}${userId}`

  try {
    const pipeline = redis.pipeline()
    pipeline.lpush(bufferKey, json)
    pipeline.ltrim(bufferKey, 0, MAX_BUFFER_SIZE - 1)
    pipeline.expire(bufferKey, BUFFER_TTL_SECONDS)
    pipeline.publish(channelKey, json)
    await pipeline.exec()
  } catch {
    // Non-fatal if Redis buffer fails; event dispatch continues
  }

  return id
}

/**
 * Retrieves buffered events for a user, optionally filtering for events occurring strictly after lastEventId.
 */
export async function getUserBufferedEvents(
  redis: Redis | undefined,
  userId: string,
  lastEventId?: string,
): Promise<SseEvent[]> {
  if (!redis) {
    return []
  }

  const bufferKey = `${BUFFER_KEY_PREFIX}${userId}`
  try {
    const rawItems = await redis.lrange(bufferKey, 0, MAX_BUFFER_SIZE - 1)
    if (!rawItems || rawItems.length === 0) {
      return []
    }

    const events: SseEvent[] = rawItems
      .map((item) => {
        try {
          return JSON.parse(item) as SseEvent
        } catch {
          return null
        }
      })
      .filter((e): e is SseEvent => e !== null)
      .reverse() // oldest first

    if (!lastEventId) {
      return events
    }

    const lastIdx = events.findIndex((e) => e.id === lastEventId)
    if (lastIdx === -1) {
      // If lastEventId is not found or expired, return all recent events
      return events
    }

    return events.slice(lastIdx + 1)
  } catch {
    return []
  }
}

/**
 * Subscribes to events for a specific user.
 * Returns an unsubscribe teardown function.
 */
export function subscribeUserEvents(
  redis: Redis | undefined,
  userId: string,
  onEvent: (event: SseEvent) => void,
): () => void {
  if (!redis) {
    return () => {}
  }

  const channelKey = `${CHANNEL_KEY_PREFIX}${userId}`
  const subscriber = redis.duplicate()

  void subscriber.subscribe(channelKey).catch(() => {})

  const messageHandler = (channel: string, message: string) => {
    if (channel === channelKey) {
      try {
        const parsed = JSON.parse(message) as SseEvent
        onEvent(parsed)
      } catch {
        // Ignore unparseable message
      }
    }
  }

  subscriber.on("message", messageHandler)

  return () => {
    subscriber.off("message", messageHandler)
    void subscriber.unsubscribe(channelKey).catch(() => {})
    void subscriber.quit().catch(() => {})
  }
}
