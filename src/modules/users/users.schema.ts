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
