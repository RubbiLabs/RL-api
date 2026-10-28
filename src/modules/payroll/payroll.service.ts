import { Prisma } from "@prisma/client"
import { FastifyInstance } from "fastify"

import { formatUsdc } from "../../lib/stellar/amount.js"

/**
 * Read-only views of the payroll contract, served from the mirror the
 * indexer maintains. Funding, withdrawing escrow, creating, pausing,
 * resuming and cancelling schedules are signed by the employer's wallet
 * directly against the contract. Escrow balances are read on-chain
 * (`escrow_of`) by the frontend.
 */

export function serializeSchedule(schedule: {
  id: string
  onChainId: bigint
  employer: string
  recipient: string
  amount: Prisma.Decimal
  period: number
  label: string
  status: string
  nextDueAt: Date
  lastDisbursedAt: Date | null
  createdAt: Date
}) {
  return {
    id: schedule.id,
    onChainId: schedule.onChainId.toString(),
    employer: schedule.employer,
    recipient: schedule.recipient,
    amount: formatUsdc(schedule.amount),
    period: schedule.period,
    label: schedule.label,
    status: schedule.status,
    nextDueAt: schedule.nextDueAt,
    lastDisbursedAt: schedule.lastDisbursedAt,
    createdAt: schedule.createdAt,
  }
}

/** Schedules the caller created as employer, newest first. */
export async function listMySchedules(app: FastifyInstance, stellarAddress: string) {
  const schedules = await app.prisma.payrollSchedule.findMany({
    where: { employer: stellarAddress },
    orderBy: { createdAt: "desc" },
  })
  return schedules.map(serializeSchedule)
}

/** Schedules that pay the caller, newest first. */
export async function listIncomingSchedules(app: FastifyInstance, stellarAddress: string) {
  const schedules = await app.prisma.payrollSchedule.findMany({
    where: { recipient: stellarAddress },
    orderBy: { createdAt: "desc" },
  })
  return schedules.map(serializeSchedule)
}

/** One schedule by on-chain id; only its employer or recipient may read it. */
export async function getSchedule(app: FastifyInstance, stellarAddress: string, onChainId: bigint) {
  const schedule = await app.prisma.payrollSchedule.findUnique({ where: { onChainId } })
  if (!schedule || (schedule.employer !== stellarAddress && schedule.recipient !== stellarAddress)) {
    throw app.httpErrors.notFound("Schedule not found")
  }
  return serializeSchedule(schedule)
}
