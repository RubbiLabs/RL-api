import { Keypair, rpc } from "@stellar/stellar-sdk"

import { env } from "../../config/index.js"

/** Soroban RPC client for the configured network. */
export const rpcServer = new rpc.Server(env.STELLAR_RPC_URL, {
  allowHttp: env.STELLAR_RPC_URL.startsWith("http://"),
  timeout: 30_000,
})

export const networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE

export const contractIds = {
  vault: env.VAULT_CONTRACT_ID,
  subscriptions: env.SUBSCRIPTIONS_CONTRACT_ID,
  payroll: env.PAYROLL_CONTRACT_ID,
  usdc: env.USDC_SAC_ID,
} as const

export type RubbiContract = "vault" | "subscriptions" | "payroll"

/** Which Rubbi contract a contract id belongs to, if any. */
export function contractNameOf(contractId: string): RubbiContract | null {
  if (contractId === contractIds.vault) return "vault"
  if (contractId === contractIds.subscriptions) return "subscriptions"
  if (contractId === contractIds.payroll) return "payroll"
  return null
}

let operator: Keypair | null = null
let keeper: Keypair | null = null
let treasury: Keypair | null | undefined

/** Signs `settle_card_spend` (card loads). */
export function getOperatorKeypair(): Keypair {
  operator ??= Keypair.fromSecret(env.OPERATOR_SECRET)
  return operator
}

/** Signs `charge_batch` / `disburse_batch` and pays for simulated reads. */
export function getKeeperKeypair(): Keypair {
  keeper ??= Keypair.fromSecret(env.KEEPER_SECRET)
  return keeper
}

/** Signs `credit_refund` (card unloads). Null when TREASURY_SECRET is unset. */
export function getTreasuryKeypair(): Keypair | null {
  if (treasury === undefined) {
    treasury = env.TREASURY_SECRET ? Keypair.fromSecret(env.TREASURY_SECRET) : null
  }
  return treasury
}
