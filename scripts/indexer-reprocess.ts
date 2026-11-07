import { parseArgs } from "node:util"
import { PrismaClient } from "@prisma/client"
import { contractIds } from "../src/config/index.js"
import { getPlan, getSchedule, getSubscription } from "../src/lib/stellar/client.js"
import { toRubbiEvent, type DecodedEvent } from "../src/lib/stellar/events.js"
import { prepareEffect, type ChainReads, type HandlerLogger } from "../src/lib/stellar/handlers.js"
import { deserializeRaw } from "../src/lib/stellar/indexer.js"

export interface ReprocessOptions {
  prisma: any
  reads: ChainReads
  log?: HandlerLogger
  id?: string
  all?: boolean
  dryRun?: boolean
}

export interface ReprocessResult {
  processed: number
  succeeded: number
  failed: number
  details: Array<{
    id: string
    eventId: string
    status: "success" | "dry-run" | "failed"
    error?: string
  }>
}

/**
 * Re-processes failed events from the dead-letter queue.
 *
 * For each unresolved dead-letter event:
 * 1. Deserializes the stored raw event and rebuilds the RubbiEvent.
 * 2. Prepares the effect (calling chain reads) and applies it inside a database transaction.
 * 3. On success, sets `reprocessedAt` to the current timestamp.
 * 4. On failure, increments `attempts` and updates `lastError`.
 */
export async function reprocessDeadLetters(options: ReprocessOptions): Promise<ReprocessResult> {
  const { prisma, reads, id, all, dryRun } = options
  const log = options.log ?? {
    info: (obj: any, msg: string) => console.log(msg, obj),
    warn: (obj: any, msg: string) => console.warn(msg, obj),
    error: (obj: any, msg: string) => console.error(msg, obj),
  }

  const where: any = { reprocessedAt: null }
  if (id) {
    where.OR = [{ id }, { eventId: id }]
  }

  const letters = await prisma.deadLetterEvent.findMany({
    where,
    orderBy: { deadAt: "asc" },
  })

  const result: ReprocessResult = {
    processed: letters.length,
    succeeded: 0,
    failed: 0,
    details: [],
  }

  if (letters.length === 0) {
    log.info({}, "No pending dead-letter events found matching criteria")
    return result
  }

  for (const letter of letters) {
    if (dryRun) {
      log.info(
        { id: letter.id, eventId: letter.eventId, type: letter.type, ledger: letter.ledger },
        "[dry-run] Would reprocess dead-letter event",
      )
      result.details.push({
        id: letter.id,
        eventId: letter.eventId,
        status: "dry-run",
      })
      continue
    }

    try {
      const decoded = deserializeRaw(letter.raw) as DecodedEvent
      const event = toRubbiEvent(decoded)
      if (!event) {
        throw new Error(`Cannot rebuild RubbiEvent from stored raw event for ${letter.eventId}`)
      }

      const effect = await prepareEffect(event, decoded, { log, reads })

      await prisma.$transaction(async (tx: any) => {
        await effect(tx)
        await tx.deadLetterEvent.update({
          where: { id: letter.id },
          data: {
            reprocessedAt: new Date(),
          },
        })
      })

      log.info({ id: letter.id, eventId: letter.eventId }, "Dead-letter event reprocessed successfully")
      result.succeeded++
      result.details.push({
        id: letter.id,
        eventId: letter.eventId,
        status: "success",
      })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      log.error({ id: letter.id, eventId: letter.eventId, err: error }, "Failed to reprocess dead-letter event")
      result.failed++
      result.details.push({
        id: letter.id,
        eventId: letter.eventId,
        status: "failed",
        error: errMsg,
      })

      await prisma.deadLetterEvent.update({
        where: { id: letter.id },
        data: {
          attempts: { increment: 1 },
          lastError: errMsg,
        },
      })
    }
  }

  return result
}

// CLI entry point
if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      id: { type: "string" },
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  })

  if (!values.id && !values.all) {
    console.error("Usage: bun run indexer:reprocess [--id <eventId>] [--all] [--dry-run]")
    process.exit(1)
  }

  const prisma = new PrismaClient()
  try {
    const reads: ChainReads = { getPlan, getSchedule, getSubscription }
    const result = await reprocessDeadLetters({
      prisma,
      reads,
      id: values.id,
      all: values.all,
      dryRun: values["dry-run"],
    })
    console.log(
      `Reprocess complete: ${result.processed} processed, ${result.succeeded} succeeded, ${result.failed} failed.`,
    )
  } finally {
    await prisma.$disconnect()
  }
}
