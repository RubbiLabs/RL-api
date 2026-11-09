import { z } from "zod"

export const usernameBodySchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9_]+$/, "Username can only contain lowercase letters, numbers and underscores"),
})

export type UsernameBody = z.infer<typeof usernameBodySchema>

export const updateProfileBodySchema = z.object({
  email: z.string().email("Invalid email format").nullable().optional(),
  notifyEmail: z.boolean().optional(),
})

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>
