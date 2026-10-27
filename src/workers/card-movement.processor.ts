import { BalanceAccount, CardMoveStatus, Prisma, PrismaClient, TransactionType } from "@prisma/client"
import { createHash, randomUUID } from "node:crypto"

import type { ICardIssuer } from "../lib/card-issuer/index.js"
import { decimalToStroops } from "../lib/stellar/amount.js"
import { VaultRejected, type VaultClient } from "../lib/stellar/vault.js"

/**
 * Card load / unload processing.
 *
 * LOAD:   PENDING --settle_card_spend (operator)--> SETTLED --fund card--> COMPLETED
 *         cardBalance is credited with the fund step; walletBalance is debited
 *         by the indexer when `card_spend_settled` arrives.
 * UNLOAD: PENDING --defund card, debit cardBalance--> SETTLED
 *                 --credit_refund (treasury)--> COMPLETED
 *         or SETTLED --> PENDING_TREASURY when no treasury key is configured
 *         (scripts/process-pending-unloads.ts finishes it); walletBalance is
 *         credited by the indexer when `refund_credited` arrives.
 *
 * Every step is idempotent: the status is re-read on each attempt, the
 * on-chain reference (sha256 of the movement id) makes the contract calls
 * replay-safe (DuplicateReference = already done), and the issuer calls carry
 * the same reference.
 */

export interface MovementLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
  error: (obj: Record<string, unknown>, msg: string) => void
}

export interface MovementDeps {
  prisma: PrismaClient
  vault: VaultClient
  cardIssuer: ICardIssuer
  log: MovementLogger
  enqueueUnload: (movementId: string) => Promise<void>
}

/** Idempotency key for the vault: sha256 of the movement id, hex. */
export function referenceFor(movementId: string): string {
  return createHash("sha256").update(movementId).digest("hex")
}

export function newMovementId(): string {
  return randomUUID()
}

/** Marks a movement FAILED; never throws. */
async function fail(deps: MovementDeps, movementId: string, reason: string) {
  await deps.prisma.cardMovement.updateMany({
    where: { id: movementId, status: { notIn: [CardMoveStatus.COMPLETED, CardMoveStatus.FAILED] } },
    data: { status: CardMoveStatus.FAILED, failureReason: reason.slice(0, 500) },
  })
}

async function loadMovement(deps: MovementDeps, movementId: string) {
  const movement = await deps.prisma.cardMovement.findUnique({
    where: { id: movementId },
    include: { user: { include: { card: true } } },
  })
  if (!movement) throw new Error(`card movement ${movementId} not found`)
  return movement
}

// ---------------------------------------------------------------------------
// LOAD

export async function processLoad(deps: MovementDeps, movementId: string): Promise<CardMoveStatus> {
  let movement = await loadMovement(deps, movementId)
  if (movement.direction !== "LOAD") throw new Error(`movement ${movementId} is not a load`)
  if (movement.status === CardMoveStatus.COMPLETED || movement.status === CardMoveStatus.FAILED) {
    return movement.status
  }

  const log = { movementId, userId: movement.userId, amount: movement.amount.toFixed() }

  if (movement.status === CardMoveStatus.PENDING) {
    let result
    try {
      result = await deps.vault.settleCardSpend({
        user: movement.user.stellarAddress,
        amount: decimalToStroops(movement.amount),
        reference: movement.reference,
      })
    } catch (error) {
      if (error instanceof VaultRejected) {
        deps.log.warn({ ...log, errorName: error.errorName }, "card load rejected on-chain")
        await fail(deps, movementId, error.errorName)
        return CardMoveStatus.FAILED
      }
      throw error
    }

    await deps.prisma.cardMovement.updateMany({
      where: { id: movementId, status: CardMoveStatus.PENDING },
      data: {
        status: CardMoveStatus.SETTLED,
        settledAt: new Date(),
        ...(result.outcome === "submitted" ? { txHash: result.hash } : {}),
      },
    })
    deps.log.info({ ...log, outcome: result.outcome }, "card load settled on-chain")
    movement = await loadMovement(deps, movementId)
  }

  if (movement.status !== CardMoveStatus.SETTLED) {
    return movement.status
  }

  const card = movement.user.card
  if (!card) {
    throw new Error(`user ${movement.userId} has no card`)
  }

  // Issuer funding: throws are retried by the queue; final failure is
  // handled by `compensateFailedLoad`.
  await deps.cardIssuer.fundCard(card.issuerId, movement.amount.toFixed(), movement.reference)

  await deps.prisma.$transaction(async (tx) => {
    const claimed = await tx.cardMovement.updateMany({
      where: { id: movementId, status: CardMoveStatus.SETTLED },
      data: { status: CardMoveStatus.COMPLETED, completedAt: new Date() },
    })
    if (claimed.count === 0) return

    const user = await tx.user.update({
      where: { id: movement.userId },
      data: { cardBalance: { increment: movement.amount } },
      select: { cardBalance: true },
    })
    await tx.transaction.create({
      data: {
        userId: movement.userId,
        type: TransactionType.CARD_LOAD,
        account: BalanceAccount.CARD,
        amount: movement.amount,
        balanceAfter: user.cardBalance,
        description: "Card loaded",
        metadata: { movementId, reference: movement.reference, txHash: movement.txHash } as Prisma.InputJsonObject,
      },
    })
  })

  deps.log.info(log, "card load completed")
  return CardMoveStatus.COMPLETED
}

/**
 * Called when a load job has exhausted its attempts. If the on-chain
 * settlement already happened, the funds are returned with a compensating
 * unload (which skips the card step) and the load is marked FAILED.
 */
export async function compensateFailedLoad(deps: MovementDeps, movementId: string, reason: string) {
  const movement = await loadMovement(deps, movementId)
  if (movement.status === CardMoveStatus.COMPLETED || movement.status === CardMoveStatus.FAILED) return

  await fail(deps, movementId, reason)

  if (movement.status !== CardMoveStatus.SETTLED) {
    // Nothing moved on-chain; nothing to return.
    return
  }

  const id = newMovementId()
  await deps.prisma.cardMovement.create({
    data: {
      id,
      userId: movement.userId,
      direction: "UNLOAD",
      amount: movement.amount,
      reference: referenceFor(id),
      status: CardMoveStatus.SETTLED, // card step skipped: the card was never funded
      compensatesId: movementId,
      settledAt: new Date(),
    },
  })
  deps.log.error({ movementId, compensationId: id, reason }, "card load failed after settlement; returning funds")
  await deps.enqueueUnload(id)
}

// ---------------------------------------------------------------------------
// UNLOAD

export async function processUnload(deps: MovementDeps, movementId: string): Promise<CardMoveStatus> {
  let movement = await loadMovement(deps, movementId)
  if (movement.direction !== "UNLOAD") throw new Error(`movement ${movementId} is not an unload`)
  if (movement.status === CardMoveStatus.COMPLETED || movement.status === CardMoveStatus.FAILED) {
    return movement.status
  }

  const log = { movementId, userId: movement.userId, amount: movement.amount.toFixed() }

  if (movement.status === CardMoveStatus.PENDING) {
    const card = movement.user.card
    if (!card) throw new Error(`user ${movement.userId} has no card`)

    if (movement.user.cardBalance.lessThan(movement.amount)) {
      await fail(deps, movementId, "InsufficientCardBalance")
      return CardMoveStatus.FAILED
    }

    await deps.cardIssuer.defundCard(card.issuerId, movement.amount.toFixed(), movement.reference)

    await deps.prisma.$transaction(async (tx) => {
      const claimed = await tx.cardMovement.updateMany({
        where: { id: movementId, status: CardMoveStatus.PENDING },
        data: { status: CardMoveStatus.SETTLED, settledAt: new Date() },
      })
      if (claimed.count === 0) return

      const user = await tx.user.update({
        where: { id: movement.userId },
        data: { cardBalance: { decrement: movement.amount } },
        select: { cardBalance: true },
      })
      if (user.cardBalance.isNegative()) {
        throw new Error(`cardBalance of user ${movement.userId} would become ${user.cardBalance.toFixed()}`)
      }
      await tx.transaction.create({
        data: {
          userId: movement.userId,
          type: TransactionType.CARD_UNLOAD,
          account: BalanceAccount.CARD,
          amount: movement.amount.negated(),
          balanceAfter: user.cardBalance,
          description: "Card unloaded",
          metadata: { movementId, reference: movement.reference } as Prisma.InputJsonObject,
        },
      })
    })
    deps.log.info(log, "card unload: card defunded")
    movement = await loadMovement(deps, movementId)
  }

  if (movement.status !== CardMoveStatus.SETTLED && movement.status !== CardMoveStatus.PENDING_TREASURY) {
    return movement.status
  }

  if (!deps.vault.creditRefund) {
    await deps.prisma.cardMovement.updateMany({
      where: { id: movementId, status: CardMoveStatus.SETTLED },
      data: { status: CardMoveStatus.PENDING_TREASURY },
    })
    deps.log.warn(log, "card unload waiting for the treasury (TREASURY_SECRET unset); run scripts/process-pending-unloads.ts")
    return CardMoveStatus.PENDING_TREASURY
  }

  let result
  try {
    result = await deps.vault.creditRefund({
      user: movement.user.stellarAddress,
      amount: decimalToStroops(movement.amount),
      reference: movement.reference,
    })
  } catch (error) {
    if (error instanceof VaultRejected) {
      // The card side is done; the money is in the treasury. Leave it for
      // the operator rather than failing the movement silently.
      deps.log.error({ ...log, errorName: error.errorName }, "credit_refund rejected; unload left PENDING_TREASURY")
      await deps.prisma.cardMovement.updateMany({
        where: { id: movementId },
        data: { status: CardMoveStatus.PENDING_TREASURY, failureReason: error.errorName },
      })
      return CardMoveStatus.PENDING_TREASURY
    }
    throw error
  }

  await deps.prisma.cardMovement.updateMany({
    where: { id: movementId, status: { in: [CardMoveStatus.SETTLED, CardMoveStatus.PENDING_TREASURY] } },
    data: {
      status: CardMoveStatus.COMPLETED,
      completedAt: new Date(),
      ...(result.outcome === "submitted" ? { txHash: result.hash } : {}),
    },
  })
  deps.log.info({ ...log, outcome: result.outcome }, "card unload credited on-chain")
  return CardMoveStatus.COMPLETED
}
