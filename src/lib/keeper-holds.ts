/**
 * Keeper holds: items whose payee cannot receive USDC right now
 * (`payout_unavailable` / `recipient_unpayable`) are left alone for
 * KEEPER_HOLD_SECONDS instead of being resubmitted every run. Holds are
 * keeper-private state and live in Redis, never in the chain mirrors.
 */
export interface KeeperHolds {
  isHeld(kind: "subscriptions" | "payroll", id: bigint): Promise<boolean>
  hold(kind: "subscriptions" | "payroll", id: bigint, seconds: number): Promise<void>
}

export interface HoldRedis {
  set: (key: string, value: string, mode: "EX", seconds: number, flag: "NX") => Promise<unknown>
  exists: (key: string) => Promise<number>
}

export const holdKey = (kind: string, id: bigint) => `keeper:hold:${kind}:${id.toString()}`

export function makeRedisHolds(redis: HoldRedis): KeeperHolds {
  return {
    isHeld: async (kind, id) => (await redis.exists(holdKey(kind, id))) > 0,
    hold: async (kind, id, seconds) => {
      await redis.set(holdKey(kind, id), "1", "EX", seconds, "NX")
    },
  }
}

export function makeMemoryHolds(): KeeperHolds & { entries: Map<string, number> } {
  const entries = new Map<string, number>()
  return {
    entries,
    isHeld: async (kind, id) => {
      const until = entries.get(holdKey(kind, id))
      return until !== undefined && until > Date.now()
    },
    hold: async (kind, id, seconds) => {
      entries.set(holdKey(kind, id), Date.now() + seconds * 1000)
    },
  }
}
