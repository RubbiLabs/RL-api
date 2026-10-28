import { Prisma } from "@prisma/client"
import { FastifyInstance } from "fastify"

import { formatUsdc } from "../../lib/stellar/amount.js"

/**
 * Read-only views of the on-chain subscriptions contract, served from the
 * mirrors the indexer maintains. Subscribing, pausing, resuming and
 * cancelling are signed by the user's wallet directly against the contract;
 * the mirrors catch up when the events arrive.
 */

export function serializePlan(plan: {
  id: number
  merchant: string
  name: string
  amount: Prisma.Decimal
  period: number
  active: boolean
}) {
  return {
    id: plan.id,
    merchant: plan.merchant,
    name: plan.name,
    amount: formatUsdc(plan.amount),
    period: plan.period,
    active: plan.active,
  }
}

export function serializeSubscription(sub: {
  id: string
  onChainSubId: bigint
  subscriber: string
  planId: number
  status: string
  nextDueAt: Date
  lastChargedAt: Date | null
  createdAt: Date
  plan?: { id: number; merchant: string; name: string; amount: Prisma.Decimal; period: number; active: boolean } | null
}) {
  return {
    id: sub.id,
    onChainSubId: sub.onChainSubId.toString(),
    subscriber: sub.subscriber,
    planId: sub.planId,
    status: sub.status,
    nextDueAt: sub.nextDueAt,
    lastChargedAt: sub.lastChargedAt,
    createdAt: sub.createdAt,
    plan: sub.plan ? serializePlan(sub.plan) : null,
  }
}

/** Plans open to new subscribers (deactivated plans are left out unless `includeInactive`). */
export async function listPlans(app: FastifyInstance, includeInactive = false) {
  const plans = await app.prisma.subscriptionPlan.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: { id: "asc" },
  })
  return plans.map(serializePlan)
}

export async function getPlanById(app: FastifyInstance, planId: number) {
  const plan = await app.prisma.subscriptionPlan.findUnique({ where: { id: planId } })
  if (!plan) {
    throw app.httpErrors.notFound("Plan not found")
  }
  return serializePlan(plan)
}

/** The caller's subscriptions (by Stellar address), newest first, with their plans. */
export async function listMySubscriptions(app: FastifyInstance, stellarAddress: string) {
  const subs = await app.prisma.subscription.findMany({
    where: { subscriber: stellarAddress },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  })
  return subs.map(serializeSubscription)
}
