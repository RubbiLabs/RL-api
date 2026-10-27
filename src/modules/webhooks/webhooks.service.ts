import { BalanceAccount, Prisma, TransactionType } from "@prisma/client"
import { FastifyInstance } from "fastify"
import { createHmac, timingSafeEqual } from "node:crypto"

import { env } from "../../config/index.js"

/**
 * Card issuer webhooks move `cardBalance` only. Card money has already been
 * moved on-chain when the card was loaded (see cards.service.ts), so a spend
 * or a merchant refund never touches the vault.
 */

export interface CardIssuerWebhookBody {
  _id?: string
  type?: string
  event?: string
  data?: {
    _id?: string
    cardId?: string
    amount?: string | number
    merchantName?: string
    merchantCategory?: string
    object?: {
      _id?: string
      card?: string | { _id?: string }
      amount?: string | number
      type?: string
      merchant?: {
        name?: string
        category?: string
      }
      transactionMetadata?: {
        type?: string
      }
    }
  }
}

function verifySignature(rawBody: string, signatureHeader: string | undefined) {
  if (!signatureHeader) {
    return false
  }

  const normalizedSignature = signatureHeader.trim().replace(/^sha256=/i, "")

  if (!/^[a-f0-9]{64}$/i.test(normalizedSignature)) {
    return false
  }

  const expected = createHmac("sha256", env.SUDO_WEBHOOK_SECRET).update(rawBody).digest()
  const receivedBuffer = Buffer.from(normalizedSignature, "hex")

  if (receivedBuffer.length !== expected.length) {
    return false
  }

  return timingSafeEqual(receivedBuffer, expected)
}

function extractWebhookData(body: CardIssuerWebhookBody) {
  const object = body.data?.object

  const cardField = object?.card
  const cardId = body.data?.cardId ?? (typeof cardField === "string" ? cardField : cardField?._id)

  const amountInput = object?.amount ?? body.data?.amount
  const merchantName = object?.merchant?.name ?? body.data?.merchantName
  const merchantCategory = object?.merchant?.category ?? body.data?.merchantCategory

  const eventType = body.type ?? body.event ?? "unknown"
  const transactionType = object?.transactionMetadata?.type ?? object?.type
  const eventId = object?._id ?? body.data?._id ?? body._id

  return { cardId, amountInput, merchantName, merchantCategory, eventType, transactionType, eventId }
}

export async function handleCardIssuerWebhook(
  app: FastifyInstance,
  body: CardIssuerWebhookBody,
  signature: string | undefined,
  rawBody: string,
) {
  if (!verifySignature(rawBody, signature)) {
    throw app.httpErrors.unauthorized("Invalid webhook signature")
  }

  const { cardId, amountInput, merchantName, merchantCategory, eventType, transactionType, eventId } =
    extractWebhookData(body)

  if (!cardId || amountInput === undefined) {
    throw app.httpErrors.badRequest("Invalid webhook payload")
  }

  const amountParsed = new Prisma.Decimal(String(amountInput))
  const amount = amountParsed.lessThan(0) ? amountParsed.mul(-1) : amountParsed

  if (amount.lte(0)) {
    return { ok: true, ignored: true, reason: "non-positive amount" }
  }

  const card = await app.prisma.card.findUnique({
    where: { issuerId: cardId },
    include: { user: true },
  })

  if (!card) {
    throw app.httpErrors.notFound("Card not found")
  }

  if (eventType === "authorization.request") {
    const responseCode = card.user.cardBalance.greaterThanOrEqualTo(amount) ? "00" : "51"
    return { statusCode: 200, data: { responseCode } }
  }

  const spendLikeEvent = eventType === "card.charge" || eventType === "transaction.created"
  if (!spendLikeEvent) {
    return { ok: true, ignored: true, reason: `unsupported event: ${eventType}` }
  }

  if (eventId) {
    const lock = await app.redis.set(`webhook:card-issuer:${eventId}`, "1", "EX", 86_400, "NX")
    if (lock !== "OK") {
      return { ok: true, duplicate: true }
    }
  }

  const isCredit = transactionType === "refund" || transactionType === "reversal"

  if (isCredit) {
    // Merchant refund or reversal: credit the card balance only.
    await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updatedUser = await tx.user.update({
        where: { id: card.user.id },
        data: { cardBalance: { increment: amount } },
        select: { cardBalance: true },
      })

      await tx.transaction.create({
        data: {
          userId: card.user.id,
          type: TransactionType.REFUND,
          account: BalanceAccount.CARD,
          amount,
          balanceAfter: updatedUser.cardBalance,
          description: `${merchantName ?? "Card"} ${transactionType}`,
          metadata: { merchantName, merchantCategory, event: eventType, transactionType, webhookEventId: eventId },
        },
      })
    })

    return { ok: true, credited: true }
  }

  if (card.user.cardBalance.lessThan(amount)) {
    throw app.httpErrors.badRequest("Insufficient card balance")
  }

  await app.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updatedUser = await tx.user.update({
      where: { id: card.user.id },
      data: { cardBalance: { decrement: amount } },
      select: { cardBalance: true },
    })

    if (updatedUser.cardBalance.isNegative()) {
      throw app.httpErrors.badRequest("Insufficient card balance")
    }

    await tx.transaction.create({
      data: {
        userId: card.user.id,
        type: TransactionType.SPEND,
        account: BalanceAccount.CARD,
        amount: amount.mul(-1),
        balanceAfter: updatedUser.cardBalance,
        description: `${merchantName ?? "Card"} charge`,
        metadata: { merchantName, merchantCategory, event: eventType, transactionType, webhookEventId: eventId },
      },
    })
  })

  return { ok: true }
}
