import { createHmac, randomUUID } from "node:crypto"

import { FastifyInstance } from "fastify"
import { z } from "zod"

import { env, type Env } from "../../config/index.js"
import { isValidUsdcAmount } from "../../lib/stellar/amount.js"
import { handleCardIssuerWebhook } from "../webhooks/webhooks.service.js"

/** Dev-only routes exist only outside production and only with the mock issuer. */
export function shouldRegisterDevRoutes(config: Pick<Env, "NODE_ENV" | "CARD_ISSUER">): boolean {
  return config.NODE_ENV !== "production" && config.CARD_ISSUER === "mock"
}

const mockSpendBodySchema = z.object({
  userId: z.string().uuid(),
  amount: z.string().refine(isValidUsdcAmount, "amount must be a positive decimal with at most 7 decimals"),
  merchantName: z.string().trim().min(1).max(80).default("Mock Merchant"),
  merchantCategory: z.string().trim().min(1).max(40).default("retail"),
})

/**
 * Builds the webhook payload the card issuer would send for a purchase on
 * `cardIssuerId`, in the shape the real webhook handler understands.
 */
export function buildMockSpendWebhook(input: {
  cardIssuerId: string
  amount: string
  merchantName: string
  merchantCategory: string
}) {
  const eventId = `mockspend_${randomUUID()}`
  const body = {
    _id: eventId,
    type: "transaction.created",
    data: {
      object: {
        _id: eventId,
        card: input.cardIssuerId,
        amount: input.amount,
        type: "purchase",
        merchant: { name: input.merchantName, category: input.merchantCategory },
        transactionMetadata: { type: "purchase" },
      },
    },
  }
  const rawBody = JSON.stringify(body)
  const signature = createHmac("sha256", env.SUDO_WEBHOOK_SECRET).update(rawBody).digest("hex")
  return { body, rawBody, signature }
}

export async function registerDevRoutes(app: FastifyInstance) {
  app.post("/dev/mock-card-spend", {
    schema: {
      tags: ["dev"],
      summary: "Simulate a card spend (mock issuer only)",
      description:
        "Builds a correctly HMAC-signed issuer webhook for a purchase on the user's mock card and " +
        "feeds it through the real webhook handler, so the full spend path (cardBalance debit, " +
        "ledger row, idempotency) is exercised. Not registered in production or under CARD_ISSUER=sudo.",
      body: {
        type: "object",
        required: ["userId", "amount"],
        properties: {
          userId: { type: "string", format: "uuid" },
          amount: { type: "string", description: "USD amount, e.g. \"12.50\"" },
          merchantName: { type: "string" },
          merchantCategory: { type: "string" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            webhookEventId: { type: "string" },
            result: { type: "object", additionalProperties: true },
            cardBalance: { type: "string" },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const parsed = mockSpendBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid body")
      }
      const { userId, amount, merchantName, merchantCategory } = parsed.data

      const card = await app.prisma.card.findUnique({ where: { userId } })
      if (!card) {
        throw app.httpErrors.notFound("User has no card")
      }

      const { body, rawBody, signature } = buildMockSpendWebhook({
        cardIssuerId: card.issuerId,
        amount,
        merchantName,
        merchantCategory,
      })

      const result = await handleCardIssuerWebhook(app, body, signature, rawBody)
      const user = await app.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { cardBalance: true },
      })

      return reply.send({
        webhookEventId: body._id,
        result,
        cardBalance: user.cardBalance.toFixed(),
      })
    },
  })
}
