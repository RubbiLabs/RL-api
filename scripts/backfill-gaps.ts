import { parseArgs } from "node:util"
import { PrismaClient } from "@prisma/client"
import { rpc as StellarRpc } from "@stellar/stellar-sdk"
import { contractIds, env } from "../src/config/index.js"
import { getPlan, getSchedule, getSubscription } from "../src/lib/stellar/client.js"
import { decodeRpcEvent } from "../src/lib/stellar/events.js"
import { type ChainReads, type HandlerLogger } from "../src/lib/stellar/handlers.js"
import { Indexer, type IndexerRpc, PAGE_LIMIT } from "../src/lib/stellar/indexer.js"

export interface BackfillOptions {
  prisma: any
  rpc: IndexerRpc
  reads: ChainReads
  contractIds?: string[]
  log?: HandlerLogger
  dryRun?: boolean
  gapId?: string
}

export interface BackfillResult {
  gapsProcessed: number
  eventsFetched: number
  eventsApplied: number
  eventsSkipped: number
  gapsResolved: string[]
}

/**
 * Recovers and backfills historical events for recorded chain gaps.
 *
 * For each unresolved `ChainGap` (or the specified `gapId`):
 * 1. Fetches contract events over `[fromLedger, toLedger]` from an archive-capable RPC.
 * 2. Applies each event in ledger order through the indexer's deduplicated transaction pipeline.
 * 3. On completion of the gap range, updates `resolvedAt` to mark the gap resolved.
 */
export async function backfillGaps(options: BackfillOptions): Promise<BackfillResult> {
  const { prisma, rpc, reads, dryRun, gapId } = options
  const contractIdsList = options.contractIds ?? [
    contractIds.vault,
    contractIds.subscriptions,
    contractIds.payroll,
  ]
  const log = options.log ?? {
    info: (obj: any, msg: string) => console.log(msg, obj),
    warn: (obj: any, msg: string) => console.warn(msg, obj),
    error: (obj: any, msg: string) => console.error(msg, obj),
  }

  const where: any = { resolvedAt: null }
  if (gapId) {
    where.id = gapId
  }

  const gaps = await prisma.chainGap.findMany({
    where,
    orderBy: { fromLedger: "asc" },
  })

  const result: BackfillResult = {
    gapsProcessed: gaps.length,
    eventsFetched: 0,
    eventsApplied: 0,
    eventsSkipped: 0,
    gapsResolved: [],
  }

  if (gaps.length === 0) {
    log.info({}, "No unresolved chain gaps found")
    return result
  }

  const indexer = new Indexer({
    prisma,
    rpc,
    reads,
    log,
    contractIds: contractIdsList,
    pollIntervalMs: 1_000,
  })

  for (const gap of gaps) {
    log.info(
      { gapId: gap.id, fromLedger: gap.fromLedger, toLedger: gap.toLedger },
      "Starting backfill for chain gap",
    )

    let currentCursor: string | undefined = undefined
    let hasMore = true
    let gapEventsApplied = 0
    let gapEventsSkipped = 0

    while (hasMore) {
      const filters = [{ type: "contract" as const, contractIds: contractIdsList }]
      const page = await rpc.getEvents(
        currentCursor
          ? { filters, cursor: currentCursor, limit: PAGE_LIMIT }
          : { filters, startLedger: gap.fromLedger, limit: PAGE_LIMIT },
      )

      if (!page.events || page.events.length === 0) {
        break
      }

      for (const rawEvent of page.events) {
        if (rawEvent.ledger > gap.toLedger) {
          hasMore = false
          break
        }

        result.eventsFetched++

        if (dryRun) {
          log.info(
            { gapId: gap.id, eventId: rawEvent.id, ledger: rawEvent.ledger },
            "[dry-run] Would apply backfill event",
          )
          continue
        }

        const decoded = decodeRpcEvent(rawEvent)
        const outcome = await indexer.applyEvent(decoded)
        if (outcome === "applied") {
          gapEventsApplied++
          result.eventsApplied++
        } else {
          gapEventsSkipped++
          result.eventsSkipped++
        }
      }

      if (page.events.length < PAGE_LIMIT || !hasMore) {
        break
      }
      currentCursor = page.cursor
    }

    if (!dryRun) {
      await prisma.chainGap.update({
        where: { id: gap.id },
        data: { resolvedAt: new Date() },
      })
      result.gapsResolved.push(gap.id)
      log.info(
        { gapId: gap.id, applied: gapEventsApplied, skipped: gapEventsSkipped },
        "Chain gap successfully resolved",
      )
    }
  }

  return result
}

// CLI entrypoint
if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      rpc: { type: "string" },
      "gap-id": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  })

  const rpcUrl = values.rpc || env.STELLAR_RPC_URL
  const rpcServer = new StellarRpc.Server(rpcUrl)
  const prisma = new PrismaClient()

  try {
    const reads: ChainReads = { getPlan, getSchedule, getSubscription }
    const result = await backfillGaps({
      prisma,
      rpc: rpcServer,
      reads,
      gapId: values["gap-id"],
      dryRun: values["dry-run"],
    })
    console.log(
      `Backfill complete: ${result.gapsProcessed} gaps checked, ${result.eventsFetched} events fetched, ${result.eventsApplied} applied, ${result.eventsSkipped} skipped, ${result.gapsResolved.length} resolved.`,
    )
  } finally {
    await prisma.$disconnect()
  }
}
