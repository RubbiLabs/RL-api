/**
 * Manual trigger and dry-run for the keeper worker (#4).
 *
 * Usage:
 *   bun run keeper [--dry-run]
 *
 * Runs one keeper pass in the current process. With `--dry-run`, it simulates
 * contract calls without submitting transactions, printing per-item decisions.
 */
import { PrismaClient } from "@prisma/client"
import Redis from "ioredis"

import { env } from "../src/config/index.js"
import { makeRedisHolds } from "../src/lib/keeper-holds.js"
import { makeKeeperChain } from "../src/lib/stellar/keeper-chain.js"
import { runKeeperOnce } from "../src/workers/keeper.processor.js"

const dryRun = process.argv.includes("--dry-run")

const prisma = new PrismaClient()
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })

const log = {
  info: (obj: Record<string, unknown>, msg: string) => console.log(`[INFO] ${msg}`, JSON.stringify(obj)),
  warn: (obj: Record<string, unknown>, msg: string) => console.warn(`[WARN] ${msg}`, JSON.stringify(obj)),
  error: (obj: Record<string, unknown>, msg: string) => console.error(`[ERROR] ${msg}`, JSON.stringify(obj)),
}

const deps = {
  prisma,
  chain: makeKeeperChain({ dryRun }),
  holds: makeRedisHolds(redis),
  log,
  holdSeconds: env.KEEPER_HOLD_SECONDS,
}

console.log(`Starting manual keeper run${dryRun ? " (dry run)" : ""}...`)
const result = await runKeeperOnce(deps, { dryRun })

console.log("Keeper run complete:")
console.log(JSON.stringify(result, null, 2))

await prisma.$disconnect()
redis.disconnect()
