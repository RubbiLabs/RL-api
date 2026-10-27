import { PrismaClient, ScheduleStatus, SubStatus } from "@prisma/client"

import type { KeeperHolds } from "../lib/keeper-holds.js"
import type { RubbiEvent } from "../lib/stellar/events.js"
import type { BatchOutcome, KeeperChain } from "../lib/stellar/keeper-chain.js"

/** `MAX_BATCH` of the contracts. */
export const MAX_BATCH = 25

export interface KeeperLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
  error: (obj: Record<string, unknown>, msg: string) => void
}

export interface KeeperDeps {
  prisma: PrismaClient
  chain: KeeperChain
  holds: KeeperHolds
  log: KeeperLogger
  holdSeconds: number
  now?: () => Date
}

export interface KeeperSummary {
  due: number
  held: number
  submitted: number
  /** Items that returned `true`. */
  paid: number
  /** Normal business outcomes: PastDue (charge_failed) or insufficient_escrow. */
  businessFailures: number
  /** Items now on hold: payout_unavailable, recipient_unpayable, merchant_inactive. */
  newHolds: number
  /** `false` with no event: not due / not chargeable on-chain (stale mirror). */
  notDue: number
  /** Items that failed even when submitted alone. */
  erroredAlone: number
  batchesRetriedItemByItem: number
}

export interface KeeperRunResult {
  subscriptions: KeeperSummary
  payroll: KeeperSummary
}

type Kind = "subscriptions" | "payroll"

const emptySummary = (): KeeperSummary => ({
  due: 0,
  held: 0,
  submitted: 0,
  paid: 0,
  businessFailures: 0,
  newHolds: 0,
  notDue: 0,
  erroredAlone: 0,
  batchesRetriedItemByItem: 0,
})

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Why an item returned `false`, read from the call's events. */
function explain(kind: Kind, id: bigint, events: RubbiEvent[]): { reason: string; hold: boolean } {
  for (const event of events) {
    if (kind === "subscriptions" && event.contract === "subscriptions") {
      if (event.name === "charge_skipped" && event.sub_id === id) {
        return { reason: event.reason, hold: true }
      }
      if (event.name === "charge_failed" && event.sub_id === id) {
        return { reason: "past_due", hold: false }
      }
    }
    if (kind === "payroll" && event.contract === "payroll") {
      if (event.name === "disburse_failed" && event.schedule_id === id) {
        return { reason: event.reason, hold: event.reason === "recipient_unpayable" }
      }
    }
  }
  return { reason: "not_due", hold: false }
}

async function classify(deps: KeeperDeps, kind: Kind, ids: bigint[], outcome: BatchOutcome, summary: KeeperSummary) {
  for (const [index, id] of ids.entries()) {
    const ok = outcome.results[index]
    if (ok) {
      summary.paid++
      deps.log.info({ kind, id: id.toString(), hash: outcome.hash }, kind === "subscriptions" ? "charged" : "disbursed")
      continue
    }
    const { reason, hold } = explain(kind, id, outcome.events)
    if (hold) {
      summary.newHolds++
      await deps.holds.hold(kind, id, deps.holdSeconds)
      deps.log.warn(
        { kind, id: id.toString(), reason, holdSeconds: deps.holdSeconds, hash: outcome.hash },
        "payee cannot be paid right now; holding the item instead of retrying every run",
      )
    } else if (reason === "not_due") {
      summary.notDue++
      deps.log.info({ kind, id: id.toString(), hash: outcome.hash }, "not due on-chain (mirror ahead of chain); skipped")
    } else {
      summary.businessFailures++
      deps.log.info({ kind, id: id.toString(), reason, hash: outcome.hash }, "not paid (normal business outcome)")
    }
  }
}

async function runKind(deps: KeeperDeps, kind: Kind, dueIds: bigint[]): Promise<KeeperSummary> {
  const summary = emptySummary()
  summary.due = dueIds.length

  const ids: bigint[] = []
  for (const id of dueIds) {
    if (await deps.holds.isHeld(kind, id)) summary.held++
    else ids.push(id)
  }

  const batch = kind === "subscriptions" ? deps.chain.chargeBatch : deps.chain.disburseBatch
  const single = kind === "subscriptions" ? deps.chain.charge : deps.chain.disburse

  for (const group of chunk(ids, MAX_BATCH)) {
    let outcome: BatchOutcome
    try {
      outcome = await batch(group)
    } catch (error) {
      // The whole batch failed (simulation or submission). Two residual
      // cases still abort a batch for everyone: a payout trustline limit
      // exceeded and the contract's own balance being frozen. Retry each
      // item alone so the others are paid, and surface the ones that keep
      // failing.
      summary.batchesRetriedItemByItem++
      deps.log.warn({ kind, size: group.length, err: error }, "batch failed; retrying its items one by one")
      for (const id of group) {
        try {
          const one = await single(id)
          summary.submitted++
          await classify(deps, kind, [id], one, summary)
        } catch (itemError) {
          summary.erroredAlone++
          deps.log.error({ kind, id: id.toString(), err: itemError }, "item fails even when submitted alone; needs attention")
        }
      }
      continue
    }
    summary.submitted += group.length
    await classify(deps, kind, group, outcome, summary)
  }

  return summary
}

/**
 * One keeper run: finds due subscriptions and schedules in the mirrors,
 * submits them in batches of at most 25, and classifies each result.
 *
 * The keeper never writes the mirrors: statuses and `nextDueAt` change only
 * when the indexer sees the resulting events.
 */
export async function runKeeper(deps: KeeperDeps): Promise<KeeperRunResult> {
  const now = (deps.now ?? (() => new Date()))()

  const dueSubscriptions = await deps.prisma.subscription.findMany({
    where: { status: { in: [SubStatus.ACTIVE, SubStatus.PAST_DUE] }, nextDueAt: { lte: now } },
    select: { onChainSubId: true },
    orderBy: { nextDueAt: "asc" },
  })
  const dueSchedules = await deps.prisma.payrollSchedule.findMany({
    where: { status: ScheduleStatus.ACTIVE, nextDueAt: { lte: now } },
    select: { onChainId: true },
    orderBy: { nextDueAt: "asc" },
  })

  const subscriptions = await runKind(
    deps,
    "subscriptions",
    dueSubscriptions.map((s) => BigInt(s.onChainSubId)),
  )
  const payroll = await runKind(
    deps,
    "payroll",
    dueSchedules.map((s) => BigInt(s.onChainId)),
  )

  deps.log.info({ subscriptions, payroll }, "keeper run finished")
  return { subscriptions, payroll }
}
