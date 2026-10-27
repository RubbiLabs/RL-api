import { Prisma, PrismaClient } from "@prisma/client"
import type { rpc } from "@stellar/stellar-sdk"

import { EventDecodeError, decodeRpcEvent, toRubbiEvent, type DecodedEvent } from "./events.js"
import { prepareEffect, type ChainReads, type HandlerLogger } from "./handlers.js"

export const CURSOR_ID = "stellar"
export const PAGE_LIMIT = 100

/** The subset of the RPC client the indexer uses (mockable in tests). */
export interface IndexerRpc {
  getEvents: (request: rpc.Api.GetEventsRequest) => Promise<rpc.Api.GetEventsResponse>
  getHealth: () => Promise<{ latestLedger: number; oldestLedger: number }>
  getLatestLedger: () => Promise<{ sequence: number }>
}

export interface IndexerOptions {
  prisma: PrismaClient
  rpc: IndexerRpc
  reads: ChainReads
  log: HandlerLogger
  contractIds: string[]
  pollIntervalMs: number
  /** First-run start ledger. Defaults to the latest ledger. */
  startLedger?: number
}

export interface RunResult {
  fetched: number
  applied: number
  skipped: number
  lastLedger: number
  cursor: string
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

function looksLikeRetentionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /oldest|retention|before.*ledger|out of range|start.*ledger|cursor/i.test(message)
}

/**
 * Cursor-based event indexer.
 *
 * Polls `getEvents` for the three Rubbi contracts from the saved cursor and
 * applies each event exactly once: the `ProcessedEvent` row is inserted in
 * the same database transaction as the event's effects, so a crash between
 * the two is impossible and a replayed page is a no-op.
 *
 * Retention: when the saved position is older than what the RPC still
 * holds, the gap is recorded (`ChainGap`), logged loudly, and indexing
 * resumes from the oldest available ledger.
 */
export class Indexer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false

  constructor(private readonly opts: IndexerOptions) {}

  start() {
    this.stopped = false
    const tick = async () => {
      if (this.stopped) return
      try {
        await this.runOnce()
      } catch (error) {
        this.opts.log.error({ err: error }, "indexer poll failed")
      }
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.opts.pollIntervalMs)
      }
    }
    void tick()
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Fetches and applies pages until a page is not full. */
  async runOnce(): Promise<RunResult> {
    if (this.running) {
      throw new Error("indexer run already in progress")
    }
    this.running = true
    try {
      const totals: RunResult = { fetched: 0, applied: 0, skipped: 0, lastLedger: 0, cursor: "" }
      for (;;) {
        const page = await this.runPage()
        totals.fetched += page.fetched
        totals.applied += page.applied
        totals.skipped += page.skipped
        totals.lastLedger = page.lastLedger
        totals.cursor = page.cursor
        if (page.fetched < PAGE_LIMIT) return totals
      }
    } finally {
      this.running = false
    }
  }

  private async fetchPage(): Promise<rpc.Api.GetEventsResponse> {
    const filters = [{ type: "contract" as const, contractIds: this.opts.contractIds }]
    const saved = await this.opts.prisma.chainCursor.findUnique({ where: { id: CURSOR_ID } })

    if (!saved) {
      const startLedger = this.opts.startLedger ?? (await this.opts.rpc.getLatestLedger()).sequence
      this.opts.log.info({ startLedger }, "indexer starting from ledger (no saved cursor)")
      return this.opts.rpc.getEvents({ filters, startLedger, limit: PAGE_LIMIT })
    }

    try {
      return await this.opts.rpc.getEvents({ filters, cursor: saved.cursor, limit: PAGE_LIMIT })
    } catch (error) {
      if (!looksLikeRetentionError(error)) throw error

      const health = await this.opts.rpc.getHealth()
      if (saved.lastLedger >= health.oldestLedger) throw error

      const gap = { fromLedger: saved.lastLedger + 1, toLedger: health.oldestLedger - 1 }
      this.opts.log.error(
        { ...gap, savedCursor: saved.cursor, oldestLedger: health.oldestLedger, latestLedger: health.latestLedger },
        "INDEXER GAP: saved cursor is older than the RPC retention window; events in this range were NOT indexed. Resuming from the oldest available ledger.",
      )
      await this.opts.prisma.chainGap.create({
        data: { ...gap, reason: error instanceof Error ? error.message : String(error) },
      })
      return this.opts.rpc.getEvents({ filters, startLedger: health.oldestLedger, limit: PAGE_LIMIT })
    }
  }

  private async runPage(): Promise<RunResult> {
    const page = await this.fetchPage()
    let applied = 0
    let skipped = 0

    for (const rawEvent of page.events) {
      const decoded = decodeRpcEvent(rawEvent)
      const outcome = await this.applyEvent(decoded)
      if (outcome === "applied") applied++
      else skipped++
    }

    const last = page.events[page.events.length - 1]
    const lastLedger = last ? last.ledger : page.latestLedger
    const cursor = page.cursor

    if (cursor) {
      await this.opts.prisma.chainCursor.upsert({
        where: { id: CURSOR_ID },
        update: { cursor, lastLedger },
        create: { id: CURSOR_ID, cursor, lastLedger },
      })
    }

    return { fetched: page.events.length, applied, skipped, lastLedger, cursor }
  }

  /** Applies one event exactly once. Returns "applied", "duplicate" or "ignored". */
  async applyEvent(decoded: DecodedEvent): Promise<"applied" | "duplicate" | "ignored"> {
    let event
    try {
      event = toRubbiEvent(decoded)
    } catch (error) {
      if (error instanceof EventDecodeError) {
        this.opts.log.error({ err: error, event: decoded }, "cannot decode event; skipped")
        return "ignored"
      }
      throw error
    }
    if (!event) return "ignored"

    const effect = await prepareEffect(event, decoded, { log: this.opts.log, reads: this.opts.reads })

    try {
      await this.opts.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: decoded.id,
            contractId: decoded.contractId,
            type: `${event.contract}.${event.name}`,
            ledger: decoded.ledger,
            txHash: decoded.txHash,
          },
        })
        await effect(tx)
      })
      return "applied"
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.opts.log.info({ eventId: decoded.id }, "event already processed; skipped")
        return "duplicate"
      }
      throw error
    }
  }
}
