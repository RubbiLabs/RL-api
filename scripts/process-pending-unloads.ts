/**
 * Finishes card unloads that are waiting for the treasury.
 *
 * Run by an operator who holds the treasury key, with TREASURY_SECRET set in
 * the environment of this process only (never in the API's .env):
 *
 *   TREASURY_SECRET=S... bun run scripts/process-pending-unloads.ts [--dry-run]
 *
 * For each CardMovement in PENDING_TREASURY it calls vault.credit_refund
 * (user, amount, reference) signed by the treasury. References make the call
 * idempotent: a movement whose refund already landed is marked COMPLETED
 * without a second transfer. The indexer credits walletBalance when the
 * `refund_credited` event arrives.
 */
import { CardMoveStatus, PrismaClient } from "@prisma/client"

import { env } from "../src/config/index.js"
import { createCardIssuer } from "../src/lib/card-issuer/factory.js"
import { formatUsdc } from "../src/lib/stellar/amount.js"
import { makeVaultClient } from "../src/lib/stellar/vault.js"
import { processUnload } from "../src/workers/card-movement.processor.js"

const dryRun = process.argv.includes("--dry-run")

if (!env.TREASURY_SECRET) {
  console.error("TREASURY_SECRET is not set; nothing can be processed.")
  process.exit(1)
}

const prisma = new PrismaClient()
const log = {
  info: (obj: Record<string, unknown>, msg: string) => console.log(msg, JSON.stringify(obj)),
  warn: (obj: Record<string, unknown>, msg: string) => console.warn(msg, JSON.stringify(obj)),
  error: (obj: Record<string, unknown>, msg: string) => console.error(msg, JSON.stringify(obj)),
}

const pending = await prisma.cardMovement.findMany({
  where: { direction: "UNLOAD", status: CardMoveStatus.PENDING_TREASURY },
  orderBy: { createdAt: "asc" },
  include: { user: { select: { stellarAddress: true } } },
})

console.log(`${pending.length} unload(s) waiting for the treasury${dryRun ? " (dry run)" : ""}`)
for (const m of pending) {
  console.log(`  ${m.id}  ${formatUsdc(m.amount)} USDC  -> ${m.user.stellarAddress}  ref ${m.reference}`)
}

if (!dryRun) {
  const deps = {
    prisma,
    vault: makeVaultClient(),
    cardIssuer: createCardIssuer(env),
    log,
    enqueueUnload: async () => {},
  }
  for (const m of pending) {
    try {
      const status = await processUnload(deps, m.id)
      console.log(`  ${m.id} -> ${status}`)
    } catch (error) {
      console.error(`  ${m.id} failed:`, error instanceof Error ? error.message : error)
    }
  }
}

await prisma.$disconnect()
