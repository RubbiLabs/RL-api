import { StrKey } from "@stellar/stellar-sdk"

/**
 * Stellar addresses are case-sensitive base32 strings. Never lower-case or
 * otherwise normalise them; compare and store them verbatim.
 */
export function isAccountAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value)
}

export function isContractAddress(value: string): boolean {
  return StrKey.isValidContract(value)
}
