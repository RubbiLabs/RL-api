import { FastifyInstance } from "fastify"
import type { ListNotificationsQuery } from "./notifications.schema.js"

export async function listNotifications(
  app: FastifyInstance,
  stellarAddress: string,
  query: ListNotificationsQuery,
) {
  const user = await app.prisma.user.findUnique({
    where: { stellarAddress },
    select: { id: true },
  })

  if (!user) {
    throw app.httpErrors.notFound("User not found")
  }

  const whereClause: any = { userId: user.id }
  if (query.unread !== undefined) {
    whereClause.readAt = query.unread ? null : { not: null }
  }

  const items = await app.prisma.notification.findMany({
    where: whereClause,
    orderBy: { createdAt: "desc" },
    take: query.limit + 1,
    skip: query.cursor ? 1 : 0,
    cursor: query.cursor ? { id: query.cursor } : undefined,
  })

  let nextCursor: string | null = null
  if (items.length > query.limit) {
    const nextItem = items.pop()!
    nextCursor = nextItem.id
  }

  return {
    notifications: items.map((n: any) => ({
      id: n.id,
      type: n.type,
      payload: n.payload,
      readAt: n.readAt ? (n.readAt instanceof Date ? n.readAt.toISOString() : n.readAt) : null,
      createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
    })),
    nextCursor,
  }
}

export async function markNotificationAsRead(
  app: FastifyInstance,
  stellarAddress: string,
  notificationId: string,
) {
  const user = await app.prisma.user.findUnique({
    where: { stellarAddress },
    select: { id: true },
  })

  if (!user) {
    throw app.httpErrors.notFound("User not found")
  }

  const notification = await app.prisma.notification.findUnique({
    where: { id: notificationId },
  })

  if (!notification || notification.userId !== user.id) {
    throw app.httpErrors.notFound("Notification not found")
  }

  const updated = await app.prisma.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  })

  return {
    id: updated.id,
    type: updated.type,
    payload: updated.payload,
    readAt: updated.readAt instanceof Date ? updated.readAt.toISOString() : updated.readAt,
    createdAt: updated.createdAt instanceof Date ? updated.createdAt.toISOString() : updated.createdAt,
  }
}
