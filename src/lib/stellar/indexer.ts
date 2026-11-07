import { Prisma, PrismaClient } from "@prisma/client"
import type { rpc } from "@stellar/stellar-sdk"

import { env } from "../../config/index.js"
import { EventDecodeError, decodeRpcEvent, toRubbiEvent, type DecodedEvent, type RubbiEvent } from "./events.js"
import { prepareEffect, LedgerInvariantError, type ChainReads, type HandlerLogger } from "./handlers.js"

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
  /** Maximum consecutive failures before dead-lettering an event. Defaults to env.INDEXER_MAX_ATTEMPTS ?? 5. */
  maxAttempts?: number
  /** Base backoff in ms for exponential retry. Defaults to 5000 ms (0 for fast tests). */
  backoffBaseMs?: number
  /** Maximum backoff cap in ms. Defaults to 300_000 ms (5 minutes). */
  maxBackoffMs?: number
}

export interface RunResult {
  fetched: number
  applied: number
  skipped: number
  deadLettered: number
  retrying: number
  lastLedger: number
  cursor: string
}

export type EventOutcome = "applied" | "duplicate" | "ignored" | "dead-lettered" | "retrying"

export interface FailingEventState {
  attempts: number
  firstFailedAt: Date
  nextRetryAt: number
  lastError: string
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

function looksLikeRetentionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /oldest|retention|before.*ledger|out of range|start.*ledger|cursor/i.test(message)
}

/** Serializes decoded event for storage in DeadLetterEvent.raw, preserving BigInt fields. */
export function serializeRaw(obj: unknown): any {
  return JSON.parse(
    JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? { __bigint: v.toString() } : v)),
  )
}

/** Deserializes DeadLetterEvent.raw back to full DecodedEvent with BigInt fields restored. */
export function deserializeRaw(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === "object") {
    if ("__bigint" in obj) return BigInt(obj.__bigint)
    if (Array.isArray(obj)) return obj.map(deserializeRaw)
    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries(obj)) {
      res[k] = deserializeRaw(v)
    }
    return res
  }
  return obj
}

/**
 * Cursor-based event indexer with dead-letter queue and backoff retries.
 *
 * Polls `getEvents` for the three Rubbi contracts from the saved cursor and
 * applies each event exactly once: the `ProcessedEvent` row is inserted in
 * the same database transaction as the event's effects.
 *
 * Resilient error handling:
 * - Failing effects are retried with exponential backoff per event id.
 * - Earlier events in the page remain committed.
 * - After `INDEXER_MAX_ATTEMPTS`, the failing event is recorded in
 *   `DeadLetterEvent` and `ProcessedEvent` inside a single transaction,
 *   allowing the cursor to advance past poison-pill events.
 */
export class Indexer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  readonly failingEvents = new Map<string, FailingEventState>()
  readonly maxAttempts: number
  readonly backoffBaseMs: number
  readonly maxBackoffMs: number

  constructor(private readonly opts: IndexerOptions) {
    this.maxAttempts = opts.maxAttempts ?? env.INDEXER_MAX_ATTEMPTS ?? 5
    this.backoffBaseMs = opts.backoffBaseMs ?? 5_000
    this.maxBackoffMs = opts.maxBackoffMs ?? 300_000
  }

  calculateBackoff(attempt: number): number {
    if (this.backoffBaseMs <= 0) return 0
    return Math.min(this.backoffBaseMs * Math.pow(3, Math.max(0, attempt - 1)), this.maxBackoffMs)
  }

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

  /** Fetches and applies pages until a page is not full or an event is retrying. */
  async runOnce(): Promise<RunResult> {
    if (this.running) {
      throw new Error("indexer run already in progress")
    }
    this.running = true
    try {
      const totals: RunResult = {
        fetched: 0,
        applied: 0,
        skipped: 0,
        deadLettered: 0,
        retrying: 0,
        lastLedger: 0,
        cursor: "",
      }
      for (;;) {
        const page = await this.runPage()
        totals.fetched += page.fetched
        totals.applied += page.applied
        totals.skipped += page.skipped
        totals.deadLettered += page.deadLettered
        totals.retrying += page.retrying
        totals.lastLedger = page.lastLedger
        totals.cursor = page.cursor
        if (page.retrying > 0 || page.fetched < PAGE_LIMIT) return totals
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
    let deadLettered = 0
    let retrying = 0

    for (const rawEvent of page.events) {
      const decoded = decodeRpcEvent(rawEvent)
      const failing = this.failingEvents.get(decoded.id)
      if (failing && Date.now() < failing.nextRetryAt) {
        retrying++
        break
      }

      const outcome = await this.applyEvent(decoded)
      if (outcome === "applied") {
        applied++
      } else if (outcome === "duplicate" || outcome === "ignored") {
        skipped++
      } else if (outcome === "dead-lettered") {
        deadLettered++
      } else if (outcome === "retrying") {
        retrying++
        break
      }
    }

    const last = page.events[page.events.length - 1]
    const lastLedger = last ? last.ledger : page.latestLedger
    const cursor = page.cursor

    if (retrying === 0 && cursor) {
      await this.opts.prisma.chainCursor.upsert({
        where: { id: CURSOR_ID },
        update: { cursor, lastLedger },
        create: { id: CURSOR_ID, cursor, lastLedger },
      })
    }

    return {
      fetched: page.events.length,
      applied,
      skipped,
      deadLettered,
      retrying,
      lastLedger,
      cursor: retrying === 0 ? cursor : "",
    }
  }

  /**
   * Applies one event exactly once.
   * Returns "applied", "duplicate", "ignored", "dead-lettered", or "retrying".
   */
  async applyEvent(decoded: DecodedEvent): Promise<EventOutcome> {
    let event: RubbiEvent | null
    try {
      event = toRubbiEvent(decoded)
    } catch (error) {
      if (error instanceof EventDecodeError) {
        this.opts.log.error({ err: error, event: decoded }, "cannot decode event; skipped")
        return "ignored"
      }
      return this.handleFailure(decoded, null, error)
    }
    if (!event) return "ignored"

    try {
      const effect = await prepareEffect(event, decoded, { log: this.opts.log, reads: this.opts.reads })

      try {
        await this.opts.prisma.$transaction(async (tx) => {
          await tx.processedEvent.create({
            data: {
              eventId: decoded.id,
              contractId: decoded.contractId,
              type: `${event!.contract}.${event!.name}`,
              ledger: decoded.ledger,
              txHash: decoded.txHash,
            },
          })
          await effect(tx)
        })
        this.failingEvents.delete(decoded.id)
        return "applied"
      } catch (error) {
        if (isUniqueViolation(error)) {
          this.opts.log.info({ eventId: decoded.id }, "event already processed; skipped")
          this.failingEvents.delete(decoded.id)
          return "duplicate"
        }
        return this.handleFailure(decoded, event, error)
      }
    } catch (error) {
      return this.handleFailure(decoded, event, error)
    }
  }

  private async handleFailure(
    decoded: DecodedEvent,
    event: RubbiEvent | null,
    error: unknown,
  ): Promise<EventOutcome> {
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (error instanceof LedgerInvariantError) {
      this.opts.log.error(
        { eventId: decoded.id, err: error, contractId: decoded.contractId, ledger: decoded.ledger },
        "LEDGER INVARIANT ERROR: mirror and chain state mismatch detected",
      )
    }

    let state = this.failingEvents.get(decoded.id)
    if (!state) {
      state = {
        attempts: 0,
        firstFailedAt: new Date(),
        nextRetryAt: 0,
        lastError: errorMsg,
      }
      this.failingEvents.set(decoded.id, state)
    }

    state.attempts++
    state.lastError = errorMsg

    if (state.attempts < this.maxAttempts) {
      const backoffMs = this.calculateBackoff(state.attempts)
      state.nextRetryAt = Date.now() + backoffMs
      this.opts.log.warn(
        {
          eventId: decoded.id,
          attempts: state.attempts,
          maxAttempts: this.maxAttempts,
          backoffMs,
          err: error,
        },
        "indexer event effect failed; scheduled retry with backoff",
      )
      return "retrying"
    }

    const eventType = event ? `${event.contract}.${event.name}` : decoded.name || "unknown"
    this.opts.log.error(
      {
        eventId: decoded.id,
        attempts: state.attempts,
        lastError: state.lastError,
        firstFailedAt: state.firstFailedAt,
      },
      "indexer event exceeded max attempts; writing to dead-letter queue",
    )

    await this.opts.prisma.$transaction(async (tx) => {
      await tx.deadLetterEvent.create({
        data: {
          eventId: decoded.id,
          contractId: decoded.contractId,
          type: eventType,
          ledger: decoded.ledger,
          txHash: decoded.txHash,
          raw: serializeRaw(decoded),
          attempts: state!.attempts,
          lastError: state!.lastError,
          firstFailedAt: state!.firstFailedAt,
          deadAt: new Date(),
        },
      })
      await tx.processedEvent.create({
        data: {
          eventId: decoded.id,
          contractId: decoded.contractId,
          type: eventType,
          ledger: decoded.ledger,
          txHash: decoded.txHash,
        },
      })
    })

    this.failingEvents.delete(decoded.id)
    return "dead-lettered"
  }
}
