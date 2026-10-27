import { FastifyInstance } from "fastify"

import { formatUsdc } from "../../lib/stellar/amount.js"

function serialize(deposit: {
  id: string
  txHash: string
  eventId: string
  amountRaw: string
  amount: { toFixed: () => string }
  status: string
  ledger: number
  confirmedAt: Date | null
  createdAt: Date
}) {
  return {
    id: deposit.id,
    txHash: deposit.txHash,
    eventId: deposit.eventId,
    amountRaw: deposit.amountRaw,
    amount: formatUsdc(deposit.amount as never),
    status: deposit.status,
    ledger: deposit.ledger,
    confirmedAt: deposit.confirmedAt,
    createdAt: deposit.createdAt,
  }
}

async function userId(app: FastifyInstance, stellarAddress: string) {
  const user = await app.prisma.user.findUnique({ where: { stellarAddress }, select: { id: true } })
  if (!user) {
    throw app.httpErrors.notFound("User not found")
  }
  return user.id
}

/** Vault deposits seen by the indexer, newest first. */
export async function listMyDeposits(app: FastifyInstance, stellarAddress: string) {
  const id = await userId(app, stellarAddress)
  const deposits = await app.prisma.deposit.findMany({
    where: { userId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
  return deposits.map(serialize)
}

/** A deposit by Stellar transaction hash (one transaction may hold several deposits; the first is returned). */
export async function getDepositByHash(app: FastifyInstance, stellarAddress: string, txHash: string) {
  const id = await userId(app, stellarAddress)
  const deposit = await app.prisma.deposit.findFirst({ where: { txHash, userId: id } })
  if (!deposit) {
    throw app.httpErrors.notFound("Deposit not found")
  }
  return serialize(deposit)
}
