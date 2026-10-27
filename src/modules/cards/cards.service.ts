import { CardMoveStatus, CardStatus, Prisma } from "@prisma/client"
import { FastifyInstance } from "fastify"

import { formatUsdc } from "../../lib/stellar/amount.js"
import { newMovementId, referenceFor } from "../../workers/card-movement.processor.js"

const OPEN_STATUSES = [CardMoveStatus.PENDING, CardMoveStatus.SETTLED, CardMoveStatus.PENDING_TREASURY]

async function userWithCard(app: FastifyInstance, stellarAddress: string) {
  const user = await app.prisma.user.findUnique({
    where: { stellarAddress },
    include: { card: true },
  })

  if (!user || !user.card) {
    throw app.httpErrors.notFound("Card not found")
  }

  return { ...user, card: user.card }
}

export function serializeMovement(movement: {
  id: string
  direction: string
  amount: Prisma.Decimal
  status: string
  reference: string
  txHash: string | null
  failureReason: string | null
  createdAt: Date
  settledAt: Date | null
  completedAt: Date | null
}) {
  return {
    id: movement.id,
    direction: movement.direction,
    amount: formatUsdc(movement.amount),
    status: movement.status,
    reference: movement.reference,
    txHash: movement.txHash,
    failureReason: movement.failureReason,
    createdAt: movement.createdAt,
    settledAt: movement.settledAt,
    completedAt: movement.completedAt,
  }
}

export async function getMyCard(app: FastifyInstance, stellarAddress: string) {
  const user = await userWithCard(app, stellarAddress)

  return {
    id: user.card.id,
    issuer: user.card.issuer,
    issuerId: user.card.issuerId,
    last4: user.card.last4,
    expiryMonth: user.card.expiryMonth,
    expiryYear: user.card.expiryYear,
    status: user.card.status,
    cardBalance: formatUsdc(user.cardBalance),
    walletBalance: formatUsdc(user.walletBalance),
  }
}

export async function freezeMyCard(app: FastifyInstance, stellarAddress: string) {
  const user = await userWithCard(app, stellarAddress)
  await app.cardIssuer.freezeCard(user.card.issuerId)
  await app.prisma.card.update({ where: { id: user.card.id }, data: { status: CardStatus.FROZEN } })
  return { status: "frozen" }
}

export async function unfreezeMyCard(app: FastifyInstance, stellarAddress: string) {
  const user = await userWithCard(app, stellarAddress)
  await app.cardIssuer.unfreezeCard(user.card.issuerId)
  await app.prisma.card.update({ where: { id: user.card.id }, data: { status: CardStatus.ACTIVE } })
  return { status: "active" }
}

export async function revealMyCardNumber(app: FastifyInstance, stellarAddress: string) {
  const user = await userWithCard(app, stellarAddress)
  const details = await app.cardIssuer.getCardDetails(user.card.issuerId)

  return {
    cardId: user.card.id,
    issuer: user.card.issuer,
    pan: details.pan ?? null,
    last4: details.last4,
    expiryMonth: details.expiryMonth,
    expiryYear: details.expiryYear,
    status: details.status,
  }
}

/** Sum of the amounts of this user's movements still in flight, per direction. */
async function openAmount(app: FastifyInstance, userId: string, direction: "LOAD" | "UNLOAD") {
  const open = await app.prisma.cardMovement.findMany({
    where: { userId, direction, status: { in: OPEN_STATUSES } },
    select: { amount: true },
  })
  return open.reduce((sum, m) => sum.plus(m.amount), new Prisma.Decimal(0))
}

/**
 * Loads `amount` USDC from the user's vault onto the card.
 *
 * Checks `amount` against `walletBalance` minus loads still in flight, then
 * creates the LOAD movement and queues it. The on-chain settlement
 * (`settle_card_spend`, operator-signed) and the issuer funding happen in
 * the worker; the vault itself is the final authority on the balance.
 */
export async function loadCard(app: FastifyInstance, stellarAddress: string, amount: string) {
  const user = await userWithCard(app, stellarAddress)
  if (user.card.status !== CardStatus.ACTIVE) {
    throw app.httpErrors.conflict("Card is not active")
  }

  const requested = new Prisma.Decimal(amount)
  const available = user.walletBalance.minus(await openAmount(app, user.id, "LOAD"))
  if (requested.greaterThan(available)) {
    throw app.httpErrors.badRequest(
      `Insufficient wallet balance: ${formatUsdc(available)} USDC available (loads in flight excluded)`,
    )
  }

  const id = newMovementId()
  const movement = await app.prisma.cardMovement.create({
    data: {
      id,
      userId: user.id,
      direction: "LOAD",
      amount: requested,
      reference: referenceFor(id),
      status: CardMoveStatus.PENDING,
    },
  })

  await app.cardMovements.enqueueLoad(movement.id)
  return serializeMovement(movement)
}

/**
 * Unloads `amount` USDC from the card back to the user's vault.
 *
 * Checks `amount` against `cardBalance` minus unloads still in flight, then
 * creates the UNLOAD movement and queues it. The worker defunds the card,
 * debits `cardBalance` and calls `credit_refund` (treasury-signed), or
 * parks the movement in PENDING_TREASURY when no treasury key is set.
 */
export async function unloadCard(app: FastifyInstance, stellarAddress: string, amount: string) {
  const user = await userWithCard(app, stellarAddress)

  const requested = new Prisma.Decimal(amount)
  const available = user.cardBalance.minus(await openAmount(app, user.id, "UNLOAD"))
  if (requested.greaterThan(available)) {
    throw app.httpErrors.badRequest(
      `Insufficient card balance: ${formatUsdc(available)} USDC available (unloads in flight excluded)`,
    )
  }

  const id = newMovementId()
  const movement = await app.prisma.cardMovement.create({
    data: {
      id,
      userId: user.id,
      direction: "UNLOAD",
      amount: requested,
      reference: referenceFor(id),
      status: CardMoveStatus.PENDING,
    },
  })

  await app.cardMovements.enqueueUnload(movement.id)
  return serializeMovement(movement)
}

export async function listMyCardMovements(app: FastifyInstance, stellarAddress: string) {
  const user = await app.prisma.user.findUnique({ where: { stellarAddress }, select: { id: true } })
  if (!user) {
    throw app.httpErrors.notFound("User not found")
  }
  const movements = await app.prisma.cardMovement.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
  return movements.map(serializeMovement)
}
