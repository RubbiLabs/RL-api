import { z } from "zod"

import { isAccountAddress, isContractAddress } from "../../lib/stellar/address.js"

export const challengeQuerySchema = z.object({
  account: z
    .string()
    .trim()
    .refine((value) => !isContractAddress(value), {
      // SEP-45 is the web-authentication standard for contract accounts
      // (passkey / smart wallets). It is a backlog item; see the README.
      message: "Contract accounts (C...) are not supported yet; SEP-45 is a backlog item",
    })
    .refine(isAccountAddress, { message: "account must be a Stellar account id (G...)" }),
})

export const tokenBodySchema = z.object({
  transaction: z.string().min(1, "transaction (base64 XDR) is required"),
})

export type ChallengeQuery = z.infer<typeof challengeQuerySchema>
export type TokenBody = z.infer<typeof tokenBodySchema>
