import { Prisma } from "@prisma/client"
import { FastifyInstance } from "fastify"

function serializeCard(card: {
  id: string
  issuer: string
  issuerId: string
  last4: string
  expiryMonth: string
  expiryYear: string
  status: string
} | null) {
  if (!card) return null
  return {
    id: card.id,
    issuer: card.issuer,
    issuerId: card.issuerId,
    last4: card.last4,
    expiryMonth: card.expiryMonth,
    expiryYear: card.expiryYear,
    status: card.status,
  }
}

export async function getMe(app: FastifyInstance, stellarAddress: string) {
  const user = await app.prisma.user.findUnique({
    where: { stellarAddress },
    include: { card: true },
  })

  if (!user) {
    throw app.httpErrors.notFound("User not found")
  }

  return {
    id: user.id,
    stellarAddress: user.stellarAddress,
    username: user.username,
    walletBalance: user.walletBalance.toString(),
    cardBalance: user.cardBalance.toString(),
    card: serializeCard(user.card),
  }
}

/**
 * Sets the user's username once and creates their card if they have none.
 *
 * One username per address (legacy defect L11): a user whose username is
 * already set gets 409; a username already taken by another user gets 409.
 */
export async function setUsername(
  app: FastifyInstance,
  stellarAddress: string,
  username: string,
) {
  const user = await app.prisma.user.findUnique({
    where: { stellarAddress },
    include: { card: true },
  })

  if (!user) {
    throw app.httpErrors.notFound("User not found")
  }

  if (user.username) {
    throw app.httpErrors.conflict("Username already set for this address")
  }

  const taken = await app.prisma.user.findUnique({
    where: { username },
    select: { id: true },
  })

  if (taken) {
    throw app.httpErrors.conflict("Username is already taken")
  }

  let updated
  try {
    updated = await app.prisma.user.update({
      where: { id: user.id },
      data: { username },
      include: { card: true },
    })
  } catch (error) {
    // Unique violation from a concurrent request for the same username.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw app.httpErrors.conflict("Username is already taken")
    }
    throw error
  }

  let card = updated.card

  if (!card) {
    const issued = await app.cardIssuer.createVirtualCard({
      userId: user.id,
      holderName: username,
      currency: "USD",
      type: "virtual",
    })

    card = await app.prisma.card.create({
      data: {
        userId: user.id,
        issuer: app.cardIssuer.name,
        issuerId: issued.id,
        last4: issued.last4,
        expiryMonth: issued.expiryMonth,
        expiryYear: issued.expiryYear,
        status: issued.status,
      },
    })
  }

  return {
    id: updated.id,
    stellarAddress: updated.stellarAddress,
    username: updated.username,
    walletBalance: updated.walletBalance.toString(),
    cardBalance: updated.cardBalance.toString(),
    card: serializeCard(card),
  }
}
