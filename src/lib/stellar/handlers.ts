import { BalanceAccount, CardMoveStatus, Prisma, SubStatus, TransactionType } from "@prisma/client"

import { stroopsToDecimal } from "./amount.js"
import type { OnChainPlan, OnChainSchedule, OnChainSubscription } from "./contracts.js"
import type { DecodedEvent, RubbiEvent } from "./events.js"

type Tx = Prisma.TransactionClient

export interface HandlerLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
  error: (obj: Record<string, unknown>, msg: string) => void
}

/** On-chain reads the handlers need before their database transaction. */
export interface ChainReads {
  getSchedule: (id: bigint) => Promise<OnChainSchedule>
  getPlan: (id: number) => Promise<OnChainPlan>
  getSubscription: (id: bigint) => Promise<OnChainSubscription>
}

export interface HandlerContext {
  log: HandlerLogger
  reads: ChainReads
}

/** The database effects of one event, applied inside the indexer's transaction. */
export type Effect = (tx: Tx) => Promise<void>

/**
 * A `withdraw` would push `walletBalance` below zero. Card money is never in
 * the vault, so this cannot happen unless the mirror and the chain disagree.
 * It is raised loudly and never clamped.
 */
export class LedgerInvariantError extends Error {}

const toDate = (unixSeconds: bigint) => new Date(Number(unixSeconds) * 1000)

function meta(event: DecodedEvent, extra: Record<string, unknown> = {}) {
  return {
    eventId: event.id,
    txHash: event.txHash,
    ledger: event.ledger,
    contract: event.contract,
    event: event.name,
    ...extra,
  }
}

async function userByAddress(tx: Tx, stellarAddress: string) {
  return tx.user.findUnique({
    where: { stellarAddress },
    select: { id: true, walletBalance: true, cardBalance: true },
  })
}

/** Credits or debits `walletBalance` and writes the ledger row in one go. */
async function moveWallet(
  tx: Tx,
  userId: string,
  delta: Prisma.Decimal,
  type: TransactionType,
  description: string,
  metadata: Record<string, unknown>,
) {
  const updated = await tx.user.update({
    where: { id: userId },
    data: { walletBalance: { increment: delta } },
    select: { walletBalance: true },
  })

  if (updated.walletBalance.isNegative()) {
    throw new LedgerInvariantError(
      `walletBalance of user ${userId} would become ${updated.walletBalance.toFixed()} after ${type} of ${delta.toFixed()}`,
    )
  }

  await tx.transaction.create({
    data: {
      userId,
      type,
      account: BalanceAccount.WALLET,
      amount: delta,
      balanceAfter: updated.walletBalance,
      description,
      metadata: metadata as Prisma.InputJsonObject,
    },
  })

  return updated.walletBalance
}

/** Informational ledger row: on-chain money that did not touch a Rubbi balance. */
async function recordInfo(
  tx: Tx,
  user: { id: string; walletBalance: Prisma.Decimal },
  type: TransactionType,
  amount: Prisma.Decimal,
  description: string,
  metadata: Record<string, unknown>,
) {
  await tx.transaction.create({
    data: {
      userId: user.id,
      type,
      account: BalanceAccount.WALLET,
      amount,
      balanceAfter: user.walletBalance,
      description,
      metadata: { ...metadata, informational: true } as Prisma.InputJsonObject,
    },
  })
}

// ---------------------------------------------------------------------------
// vault

async function vaultEffect(
  event: Extract<RubbiEvent, { contract: "vault" }>,
  raw: DecodedEvent,
  ctx: HandlerContext,
): Promise<Effect> {
  switch (event.name) {
    case "deposit": {
      const amount = stroopsToDecimal(event.amount)
      return async (tx) => {
        const user = await userByAddress(tx, event.user)
        if (!user) {
          ctx.log.info(meta(raw, { user: event.user }), "deposit from an address that is not a Rubbi user; ignored")
          return
        }
        await tx.deposit.create({
          data: {
            userId: user.id,
            txHash: raw.txHash,
            eventId: raw.id,
            amountRaw: event.amount.toString(),
            amount,
            status: "CONFIRMED",
            ledger: raw.ledger,
            confirmedAt: raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt) : new Date(),
          },
        })
        await moveWallet(tx, user.id, amount, TransactionType.DEPOSIT, "Vault deposit confirmed", meta(raw))
      }
    }

    case "withdraw": {
      const amount = stroopsToDecimal(event.amount)
      return async (tx) => {
        const user = await userByAddress(tx, event.user)
        if (!user) {
          ctx.log.info(meta(raw, { user: event.user }), "withdraw by an address that is not a Rubbi user; ignored")
          return
        }
        await moveWallet(tx, user.id, amount.negated(), TransactionType.WITHDRAWAL, "Vault withdrawal", meta(raw))
      }
    }

    case "card_spend_settled": {
      // A card load: USDC moved from the user's vault to the treasury.
      const amount = stroopsToDecimal(event.amount)
      return async (tx) => {
        const user = await userByAddress(tx, event.user)
        if (!user) {
          ctx.log.warn(meta(raw, { user: event.user }), "settlement for an address that is not a Rubbi user; ignored")
          return
        }
        const movement = await tx.cardMovement.findUnique({ where: { reference: event.reference } })
        if (movement) {
          await tx.cardMovement.updateMany({
            where: { id: movement.id, status: CardMoveStatus.PENDING },
            data: { status: CardMoveStatus.SETTLED, txHash: raw.txHash, settledAt: new Date() },
          })
          await moveWallet(tx, user.id, amount.negated(), TransactionType.CARD_LOAD, "Card load settled on-chain", {
            ...meta(raw),
            movementId: movement.id,
            reference: event.reference,
          })
        } else {
          ctx.log.warn(meta(raw, { reference: event.reference }), "settlement without a matching card load")
          await moveWallet(
            tx,
            user.id,
            amount.negated(),
            TransactionType.CARD_SPEND_SETTLED,
            "Operator settlement",
            { ...meta(raw), reference: event.reference },
          )
        }
      }
    }

    case "refund_credited": {
      // A card unload: USDC moved from the treasury back to the user's vault.
      const amount = stroopsToDecimal(event.amount)
      return async (tx) => {
        const user = await userByAddress(tx, event.user)
        if (!user) {
          ctx.log.warn(meta(raw, { user: event.user }), "refund for an address that is not a Rubbi user; ignored")
          return
        }
        const movement = await tx.cardMovement.findUnique({ where: { reference: event.reference } })
        if (movement) {
          await tx.cardMovement.updateMany({
            where: {
              id: movement.id,
              status: { in: [CardMoveStatus.PENDING, CardMoveStatus.PENDING_TREASURY, CardMoveStatus.SETTLED] },
            },
            data: {
              status: CardMoveStatus.COMPLETED,
              txHash: raw.txHash,
              settledAt: new Date(),
              completedAt: new Date(),
            },
          })
          await moveWallet(tx, user.id, amount, TransactionType.CARD_UNLOAD, "Card unload credited on-chain", {
            ...meta(raw),
            movementId: movement.id,
            reference: event.reference,
          })
        } else {
          ctx.log.warn(meta(raw, { reference: event.reference }), "refund without a matching card unload")
          await moveWallet(tx, user.id, amount, TransactionType.REFUND, "Treasury refund", {
            ...meta(raw),
            reference: event.reference,
          })
        }
      }
    }

    default:
      return async () => {
        ctx.log.info(meta(raw, { data: raw.data }), "vault admin event")
      }
  }
}

// ---------------------------------------------------------------------------
// subscriptions

function planData(plan: { id: number; merchant: string; name: string; amount: bigint; period: bigint; active?: boolean }) {
  return {
    merchant: plan.merchant,
    name: plan.name,
    amount: stroopsToDecimal(plan.amount),
    period: Number(plan.period),
    active: plan.active ?? true,
  }
}

async function ensurePlan(tx: Tx, planId: number, ctx: HandlerContext, fetched?: OnChainPlan) {
  const existing = await tx.subscriptionPlan.findUnique({ where: { id: planId } })
  if (existing) return existing
  const plan = fetched ?? (await ctx.reads.getPlan(planId))
  return tx.subscriptionPlan.upsert({
    where: { id: planId },
    update: planData(plan),
    create: { id: planId, ...planData(plan) },
  })
}

async function subscriptionsEffect(
  event: Extract<RubbiEvent, { contract: "subscriptions" }>,
  raw: DecodedEvent,
  ctx: HandlerContext,
): Promise<Effect> {
  switch (event.name) {
    case "plan_created":
      return async (tx) => {
        const data = planData({
          id: event.plan_id,
          merchant: event.merchant,
          name: event.plan_name,
          amount: event.amount,
          period: event.period,
        })
        await tx.subscriptionPlan.upsert({
          where: { id: event.plan_id },
          update: data,
          create: { id: event.plan_id, ...data },
        })
      }

    case "plan_active_set": {
      // The plan may be unknown after a retention gap; fetch it then.
      const existing = await ctx.reads.getPlan(event.plan_id).catch(() => null)
      return async (tx) => {
        const plan = await tx.subscriptionPlan.findUnique({ where: { id: event.plan_id } })
        if (!plan && existing) {
          await ensurePlan(tx, event.plan_id, ctx, { ...existing, active: event.active })
          return
        }
        await tx.subscriptionPlan.updateMany({
          where: { id: event.plan_id },
          data: { active: event.active },
        })
      }
    }

    case "subscribed": {
      const planIfMissing = await ctx.reads.getPlan(event.plan_id).catch(() => undefined)
      return async (tx) => {
        await ensurePlan(tx, event.plan_id, ctx, planIfMissing)
        const user = await userByAddress(tx, event.subscriber)
        const data = {
          subscriber: event.subscriber,
          userId: user?.id ?? null,
          planId: event.plan_id,
          status: SubStatus.ACTIVE,
          nextDueAt: toDate(event.next_due),
          lastChargedAt: raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt) : new Date(),
        }
        await tx.subscription.upsert({
          where: { onChainSubId: event.sub_id },
          update: data,
          create: { onChainSubId: event.sub_id, ...data },
        })
      }
    }

    case "charged": {
      const amount = stroopsToDecimal(event.amount)
      return async (tx) => {
        const updated = await tx.subscription.updateMany({
          where: { onChainSubId: event.sub_id },
          data: {
            status: SubStatus.ACTIVE,
            nextDueAt: toDate(event.next_due),
            lastChargedAt: raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt) : new Date(),
          },
        })
        if (updated.count === 0) {
          ctx.log.warn(meta(raw, { subId: event.sub_id.toString() }), "charged for an unknown subscription (gap?)")
        }
        const user = await userByAddress(tx, event.subscriber)
        if (user) {
          await recordInfo(tx, user, TransactionType.SUBSCRIPTION_PAYMENT, amount, "Subscription charged", {
            ...meta(raw),
            subId: event.sub_id.toString(),
            planId: event.plan_id,
            merchant: event.merchant,
            fee: event.fee.toString(),
          })
        }
      }
    }

    case "charge_failed":
      return async (tx) => {
        await tx.subscription.updateMany({
          where: { onChainSubId: event.sub_id },
          data: { status: SubStatus.PAST_DUE },
        })
      }

    case "charge_skipped":
      return async () => {
        ctx.log.info(
          meta(raw, { subId: event.sub_id.toString(), reason: event.reason }),
          "charge skipped (no state change)",
        )
      }

    case "subscription_paused":
      return async (tx) => {
        await tx.subscription.updateMany({
          where: { onChainSubId: event.sub_id },
          data: { status: SubStatus.PAUSED },
        })
      }

    case "subscription_resumed":
      return async (tx) => {
        await tx.subscription.updateMany({
          where: { onChainSubId: event.sub_id },
          data: { status: SubStatus.ACTIVE, nextDueAt: toDate(event.next_due) },
        })
      }

    case "subscription_cancelled":
      return async (tx) => {
        await tx.subscription.updateMany({
          where: { onChainSubId: event.sub_id },
          data: { status: SubStatus.CANCELLED },
        })
      }

    default:
      return async () => {
        ctx.log.info(meta(raw, { data: raw.data }), "subscriptions admin/merchant event")
      }
  }
}

// ---------------------------------------------------------------------------
// payroll

const SCHEDULE_STATUS = { Active: "ACTIVE", Paused: "PAUSED", Cancelled: "CANCELLED" } as const

async function payrollEffect(
  event: Extract<RubbiEvent, { contract: "payroll" }>,
  raw: DecodedEvent,
  ctx: HandlerContext,
): Promise<Effect> {
  switch (event.name) {
    case "funded": {
      const amount = stroopsToDecimal(event.amount)
      return async (tx) => {
        const user = await userByAddress(tx, event.employer)
        if (user) {
          await recordInfo(tx, user, TransactionType.PAYROLL_FUNDED, amount, "Payroll escrow funded", meta(raw))
        }
      }
    }

    case "escrow_withdrawn":
      return async () => {
        ctx.log.info(meta(raw, { employer: event.employer, amount: event.amount.toString() }), "escrow withdrawn")
      }

    case "schedule_created": {
      // The event carries no label (event size limits); read it on-chain.
      const onChain = await ctx.reads.getSchedule(event.schedule_id)
      return async (tx) => {
        const employer = await userByAddress(tx, event.employer)
        const data = {
          employer: event.employer,
          employerUserId: employer?.id ?? null,
          recipient: event.recipient,
          amount: stroopsToDecimal(event.amount),
          period: Number(event.period),
          label: onChain.label,
          status: SCHEDULE_STATUS[onChain.status] ?? "ACTIVE",
          nextDueAt: toDate(event.next_due),
        }
        await tx.payrollSchedule.upsert({
          where: { onChainId: event.schedule_id },
          update: data,
          create: { onChainId: event.schedule_id, ...data },
        })
      }
    }

    case "disbursed": {
      const amount = stroopsToDecimal(event.amount)
      return async (tx) => {
        const updated = await tx.payrollSchedule.updateMany({
          where: { onChainId: event.schedule_id },
          data: {
            nextDueAt: toDate(event.next_due),
            lastDisbursedAt: raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt) : new Date(),
          },
        })
        if (updated.count === 0) {
          ctx.log.warn(meta(raw, { scheduleId: event.schedule_id.toString() }), "disbursed for an unknown schedule (gap?)")
        }
        const recipient = await userByAddress(tx, event.recipient)
        if (recipient) {
          await recordInfo(tx, recipient, TransactionType.PAYROLL_DISBURSED, amount, "Salary received", {
            ...meta(raw),
            scheduleId: event.schedule_id.toString(),
            employer: event.employer,
            fee: event.fee.toString(),
          })
        }
      }
    }

    case "disburse_failed":
      return async () => {
        ctx.log.warn(
          meta(raw, {
            scheduleId: event.schedule_id.toString(),
            reason: event.reason,
            escrow: event.escrow.toString(),
            amount: event.amount.toString(),
          }),
          "disbursement failed (period stays owed)",
        )
      }

    case "schedule_paused":
      return async (tx) => {
        await tx.payrollSchedule.updateMany({
          where: { onChainId: event.schedule_id },
          data: { status: "PAUSED" },
        })
      }

    case "schedule_resumed":
      return async (tx) => {
        await tx.payrollSchedule.updateMany({
          where: { onChainId: event.schedule_id },
          data: { status: "ACTIVE", nextDueAt: toDate(event.next_due) },
        })
      }

    case "schedule_cancelled":
      return async (tx) => {
        await tx.payrollSchedule.updateMany({
          where: { onChainId: event.schedule_id },
          data: { status: "CANCELLED" },
        })
      }

    default:
      return async () => {
        ctx.log.info(meta(raw, { data: raw.data }), "payroll admin event")
      }
  }
}

/**
 * Prepares the database effect of one Rubbi event. Any on-chain read the
 * effect needs happens here, before the indexer opens its transaction.
 */
export async function prepareEffect(event: RubbiEvent, raw: DecodedEvent, ctx: HandlerContext): Promise<Effect> {
  switch (event.contract) {
    case "vault":
      return vaultEffect(event, raw, ctx)
    case "subscriptions":
      return subscriptionsEffect(event, raw, ctx)
    case "payroll":
      return payrollEffect(event, raw, ctx)
  }
}
