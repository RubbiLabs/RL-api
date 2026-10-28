import { Keypair } from "@stellar/stellar-sdk"

import { contractIds, getOperatorKeypair, getTreasuryKeypair } from "./client.js"
import { SimulationFailed, arg, invoke, type InvokeResult } from "./tx.js"

/** The two vault calls the backend signs. Amounts are i128 stroops. */
export interface VaultClient {
  /** `settle_card_spend` signed by the operator: user's vault → treasury. */
  settleCardSpend(input: { user: string; amount: bigint; reference: string }): Promise<VaultCallResult>
  /** `credit_refund` signed by the treasury: treasury → user's vault. Null when no treasury key is configured. */
  creditRefund: ((input: { user: string; amount: bigint; reference: string }) => Promise<VaultCallResult>) | null
}

export type VaultCallResult =
  | { outcome: "submitted"; hash: string; ledger: number }
  /** The reference was already used: the call happened earlier (idempotent). */
  | { outcome: "duplicate" }

/** A contract-level rejection that retrying will not fix. */
export class VaultRejected extends Error {
  constructor(readonly errorName: string) {
    super(`vault rejected the call: ${errorName}`)
  }
}

async function call(method: string, args: ReturnType<typeof arg.address>[], signer: Keypair): Promise<VaultCallResult> {
  let result: InvokeResult
  try {
    result = await invoke({ contractId: contractIds.vault, method, args }, signer)
  } catch (error) {
    if (error instanceof SimulationFailed) {
      if (error.errorName === "DuplicateReference") return { outcome: "duplicate" }
      if (error.errorName) throw new VaultRejected(error.errorName)
    }
    throw error
  }
  return { outcome: "submitted", hash: result.hash, ledger: result.ledger }
}

export function makeVaultClient(): VaultClient {
  const treasury = getTreasuryKeypair()
  return {
    settleCardSpend: ({ user, amount, reference }) =>
      call("settle_card_spend", [arg.address(user), arg.i128(amount), arg.bytes32(reference)], getOperatorKeypair()),
    creditRefund: treasury
      ? ({ user, amount, reference }) =>
          call("credit_refund", [arg.address(user), arg.i128(amount), arg.bytes32(reference)], treasury)
      : null,
  }
}
