import { z } from "zod"

import { isValidUsdcAmount } from "../../lib/stellar/amount.js"

export const cardActionSchema = z.object({
  reason: z.string().trim().min(1).max(140).optional(),
})

export const cardMoveBodySchema = z.object({
  amount: z
    .string()
    .trim()
    .refine(isValidUsdcAmount, "amount must be a positive decimal USDC amount with at most 7 decimals"),
})

export type CardMoveBody = z.infer<typeof cardMoveBodySchema>
