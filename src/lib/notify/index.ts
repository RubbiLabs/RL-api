import { Prisma } from "@prisma/client"
import { env } from "../../config/index.js"

export interface NotificationPayload {
  userId: string
  type: string
  payload: Record<string, unknown>
}

export function buildNotificationEmailText(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case "charge_failed":
      return `Your subscription charge of ${payload.amount ?? ""} USDC failed. Reason: ${payload.reason ?? "insufficient balance"}. Please update your account.`
    case "charged":
      return `Your subscription charge of ${payload.amount ?? ""} USDC to ${payload.merchant ?? "merchant"} was successful.`
    case "disburse_failed":
      return `Payroll disbursement for schedule ${payload.label ?? payload.scheduleId} failed. Reason: ${payload.reason ?? "insufficient escrow"}.`
    case "disbursed":
      return `You received a payroll disbursement of ${payload.amount ?? ""} USDC from ${payload.employer ?? "employer"}.`
    case "card_load_completed":
      return `Your card load of ${payload.amount ?? ""} USDC has completed successfully.`
    case "card_load_failed":
      return `Your card load of ${payload.amount ?? ""} USDC failed. Reason: ${payload.reason ?? "issuer error"}.`
    case "card_unload_completed":
      return `Your card unload of ${payload.amount ?? ""} USDC has completed and refunded to your vault.`
    case "refund_credited":
      return `A refund of ${payload.amount ?? ""} USDC has been credited to your account.`
    case "subscription_cancelled":
      return `Your subscription to ${payload.planName ?? "plan"} has been cancelled because the merchant deactivated the plan.`
    default:
      return `You have a new Rubbi notification: ${type}.`
  }
}

export async function emitNotification(
  tx: Prisma.TransactionClient | any,
  data: NotificationPayload,
  logger?: { info: (...args: any[]) => void; error: (...args: any[]) => void },
) {
  const notification = await tx.notification.create({
    data: {
      userId: data.userId,
      type: data.type,
      payload: data.payload,
    },
  })

  // Delivery channel: Email if configured and user opted in
  if (env.NOTIFY_EMAIL_HOST) {
    try {
      const user = await tx.user.findUnique({
        where: { id: data.userId },
        select: { email: true, notifyEmail: true },
      })
      if (user?.email && user.notifyEmail) {
        const text = buildNotificationEmailText(data.type, data.payload)
        logger?.info?.({ userId: data.userId, type: data.type }, "Email notification queued")
      }
    } catch (err) {
      logger?.error?.({ err, userId: data.userId }, "Failed to send email notification")
    }
  }

  return notification
}
