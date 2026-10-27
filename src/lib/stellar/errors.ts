import type { RubbiContract } from "./client.js"

/**
 * Contract error codes, copied from each contract's `src/errors.rs` in
 * RL-smart-contracts. Authorization failures are host errors, not codes.
 */
export const CONTRACT_ERRORS: Record<RubbiContract, Record<number, string>> = {
  vault: {
    1: "InvalidAmount",
    2: "InsufficientBalance",
    3: "Paused",
    4: "DuplicateReference",
    5: "NoPendingAdmin",
    6: "Overflow",
  },
  subscriptions: {
    1: "InvalidAmount",
    2: "Paused",
    3: "FeeTooHigh",
    4: "InvalidPeriod",
    5: "NameTooLong",
    6: "MerchantExists",
    7: "MerchantNotFound",
    8: "MerchantInactive",
    9: "PlanNotFound",
    10: "PlanInactive",
    11: "NotPlanOwner",
    12: "AlreadySubscribed",
    13: "SubscriptionNotFound",
    14: "NotSubscriber",
    15: "NotDue",
    16: "NotChargeable",
    17: "NotPausable",
    18: "NotPaused",
    19: "AlreadyCancelled",
    20: "PaymentFailed",
    21: "BatchTooLarge",
    22: "NoPendingAdmin",
    23: "Overflow",
    24: "PayoutUnavailable",
  },
  payroll: {
    1: "InvalidAmount",
    2: "Paused",
    3: "FeeTooHigh",
    4: "InvalidPeriod",
    5: "LabelTooLong",
    6: "InsufficientEscrow",
    7: "TooManySchedules",
    8: "FirstDueInPast",
    9: "ScheduleNotFound",
    10: "NotEmployer",
    11: "NotActive",
    12: "NotPaused",
    13: "AlreadyCancelled",
    14: "NotDue",
    15: "BatchTooLarge",
    16: "NoPendingAdmin",
    17: "Overflow",
  },
}

/**
 * Extracts the contract error code from a simulation or diagnostic message
 * such as `HostError: Error(Contract, #4)`. Returns null for host errors.
 */
export function parseContractErrorCode(message: string): number | null {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(message)
  return match && match[1] ? Number(match[1]) : null
}

export function contractErrorName(contract: RubbiContract, message: string): string | null {
  const code = parseContractErrorCode(message)
  if (code === null) return null
  return CONTRACT_ERRORS[contract][code] ?? `Unknown(${code})`
}
