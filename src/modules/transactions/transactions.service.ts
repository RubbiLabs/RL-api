import { BalanceAccount, Prisma } from "@prisma/client"
import { FastifyInstance } from "fastify"

import { formatUsdc } from "../../lib/stellar/amount.js"

interface ListTransactionsOptions {
  page: number
  pageSize: number
  account?: BalanceAccount
}

export function serializeTransaction(item: {
  id: string
  type: string
  account: string
  amount: Prisma.Decimal
  balanceAfter: Prisma.Decimal
  description: string
  metadata: unknown
  createdAt: Date
}) {
  return {
    id: item.id,
    type: item.type,
    account: item.account,
    amount: formatUsdc(item.amount),
    balanceAfter: formatUsdc(item.balanceAfter),
    description: item.description,
    metadata: item.metadata,
    createdAt: item.createdAt,
  }
}

/**
 * The user's ledger, newest first. `amount` is the signed delta applied to
 * `account` (WALLET or CARD); rows with `metadata.informational` describe
 * on-chain money that did not change a Rubbi balance (subscription charges,
 * payroll).
 */
export async function listMyTransactions(
  app: FastifyInstance,
  stellarAddress: string,
  options: ListTransactionsOptions,
) {
  const user = await app.prisma.user.findUnique({ where: { stellarAddress }, select: { id: true } })
  if (!user) {
    throw app.httpErrors.notFound("User not found")
  }

  const page = Math.max(1, options.page)
  const pageSize = Math.min(100, Math.max(1, options.pageSize))
  const skip = (page - 1) * pageSize
  const where = { userId: user.id, ...(options.account ? { account: options.account } : {}) }

  const [items, total] = await Promise.all([
    app.prisma.transaction.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
    app.prisma.transaction.count({ where }),
  ])

  return { page, pageSize, total, items: items.map(serializeTransaction) }
}
