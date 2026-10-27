import { ScheduleStatus, SubStatus } from "@prisma/client"
import { FastifyInstance } from "fastify"

import { formatUsdc } from "../../lib/stellar/amount.js"
import { serializeTransaction } from "../transactions/transactions.service.js"

/** Simple stats for the dashboard: balances, active counts and recent ledger rows. */
export async function getDashboardStats(app: FastifyInstance, stellarAddress: string) {
  const user = await app.prisma.user.findUnique({
    where: { stellarAddress },
    select: { id: true, walletBalance: true, cardBalance: true },
  })
  if (!user) {
    throw app.httpErrors.notFound("User not found")
  }

  const [activeSubscriptions, pastDueSubscriptions, activeSchedules, incomingSchedules, recentTransactions] =
    await Promise.all([
      app.prisma.subscription.count({ where: { subscriber: stellarAddress, status: SubStatus.ACTIVE } }),
      app.prisma.subscription.count({ where: { subscriber: stellarAddress, status: SubStatus.PAST_DUE } }),
      app.prisma.payrollSchedule.count({ where: { employer: stellarAddress, status: ScheduleStatus.ACTIVE } }),
      app.prisma.payrollSchedule.count({ where: { recipient: stellarAddress, status: ScheduleStatus.ACTIVE } }),
      app.prisma.transaction.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    ])

  return {
    walletBalance: formatUsdc(user.walletBalance),
    cardBalance: formatUsdc(user.cardBalance),
    activeSubscriptions,
    pastDueSubscriptions,
    activeSchedules,
    incomingSchedules,
    recentTransactions: recentTransactions.map(serializeTransaction),
  }
}
