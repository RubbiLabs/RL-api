import { z } from "zod"

export const listNotificationsQuerySchema = z.object({
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((val) => (val === undefined ? undefined : val === "true")),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>

export const notificationParamSchema = z.object({
  id: z.string().min(1, "Invalid notification id"),
})

export type NotificationParam = z.infer<typeof notificationParamSchema>
