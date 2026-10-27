import { Address, StrKey, rpc, scValToNative, xdr } from "@stellar/stellar-sdk"

import { contractNameOf, type RubbiContract } from "./client.js"

/**
 * A decoded Soroban contract event.
 *
 * Every Rubbi event is emitted with the SDK's `#[contractevent]` macro:
 * topic 0 is the event name as a symbol, further topics are the `#[topic]`
 * fields (the primary address), and the data is a map of the remaining
 * fields keyed by field name.
 */
export interface DecodedEvent {
  id: string
  contractId: string
  contract: RubbiContract | null
  ledger: number
  ledgerClosedAt: string
  txHash: string
  name: string
  topics: unknown[]
  data: Record<string, unknown>
}

function native(value: xdr.ScVal): unknown {
  return scValToNative(value)
}

function toData(value: xdr.ScVal): Record<string, unknown> {
  const decoded = native(value)
  if (decoded === null || decoded === undefined) return {}
  if (decoded instanceof Map) return Object.fromEntries(decoded)
  if (typeof decoded === "object" && !Array.isArray(decoded) && !(decoded instanceof Uint8Array)) {
    return decoded as Record<string, unknown>
  }
  return { value: decoded }
}

/** Decodes an RPC `getEvents` entry. */
export function decodeRpcEvent(event: rpc.Api.EventResponse): DecodedEvent {
  const contractId = event.contractId?.contractId() ?? ""
  const [nameVal, ...rest] = event.topic
  const name = nameVal ? native(nameVal) : undefined
  return {
    id: event.id,
    contractId,
    contract: contractNameOf(contractId),
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    txHash: event.txHash,
    name: typeof name === "string" ? name : "",
    topics: rest.map(native),
    data: toData(event.value),
  }
}

/** Decodes a contract event from a transaction result (`contractEventsXdr`). */
export function decodeContractEventXdr(
  event: xdr.ContractEvent,
  meta: { txHash: string; ledger: number; ledgerClosedAt?: string; id?: string },
): DecodedEvent {
  const contractId = event.contractId ? StrKey.encodeContract(event.contractId.value) : ""
  const body = event.body.v0
  const [nameVal, ...rest] = body.topics
  const name = nameVal ? native(nameVal) : undefined
  return {
    id: meta.id ?? `${meta.txHash}:${contractId}:${name}`,
    contractId,
    contract: contractNameOf(contractId),
    ledger: meta.ledger,
    ledgerClosedAt: meta.ledgerClosedAt ?? "",
    txHash: meta.txHash,
    name: typeof name === "string" ? name : "",
    topics: rest.map(native),
    data: toData(body.data),
  }
}

// ---------------------------------------------------------------------------
// Typed views of the Rubbi events (field names follow events.rs exactly).

export type VaultEvent =
  | { name: "deposit"; user: string; amount: bigint }
  | { name: "withdraw"; user: string; amount: bigint }
  | { name: "card_spend_settled"; user: string; amount: bigint; reference: string }
  | { name: "refund_credited"; user: string; amount: bigint; reference: string }
  | { name: "operator_set"; operator: string }
  | { name: "treasury_set"; treasury: string }
  | { name: "admin_proposed"; pending_admin: string }
  | { name: "admin_transferred"; new_admin: string; old_admin: string }
  | { name: "paused" }
  | { name: "unpaused" }
  | { name: "upgraded"; wasm_hash: string }

export type ChargeSkippedReason = "merchant_inactive" | "payout_unavailable"
export type DisburseFailedReason = "insufficient_escrow" | "recipient_unpayable"

export type SubscriptionsEvent =
  | { name: "merchant_added"; merchant: string; payout: string }
  | { name: "merchant_active_set"; merchant: string; active: boolean }
  | { name: "plan_created"; merchant: string; plan_id: number; plan_name: string; amount: bigint; period: bigint }
  | { name: "plan_active_set"; merchant: string; plan_id: number; active: boolean }
  | { name: "subscribed"; subscriber: string; sub_id: bigint; plan_id: number; next_due: bigint }
  | {
      name: "charged"
      subscriber: string
      sub_id: bigint
      plan_id: number
      merchant: string
      amount: bigint
      fee: bigint
      next_due: bigint
    }
  | { name: "charge_failed"; subscriber: string; sub_id: bigint; plan_id: number; amount: bigint }
  | { name: "charge_skipped"; subscriber: string; sub_id: bigint; reason: ChargeSkippedReason }
  | { name: "subscription_paused"; subscriber: string; sub_id: bigint }
  | { name: "subscription_resumed"; subscriber: string; sub_id: bigint; next_due: bigint }
  | { name: "subscription_cancelled"; subscriber: string; sub_id: bigint }
  | { name: "fee_set"; fee_bps: number }
  | { name: "fee_recipient_set"; fee_recipient: string }
  | { name: "admin_proposed"; pending_admin: string }
  | { name: "admin_transferred"; new_admin: string; old_admin: string }
  | { name: "paused" }
  | { name: "unpaused" }
  | { name: "upgraded"; wasm_hash: string }

export type PayrollEvent =
  | { name: "funded"; employer: string; amount: bigint }
  | { name: "escrow_withdrawn"; employer: string; amount: bigint }
  | {
      name: "schedule_created"
      employer: string
      schedule_id: bigint
      recipient: string
      amount: bigint
      period: bigint
      next_due: bigint
    }
  | {
      name: "disbursed"
      employer: string
      schedule_id: bigint
      recipient: string
      amount: bigint
      fee: bigint
      next_due: bigint
    }
  | {
      name: "disburse_failed"
      employer: string
      schedule_id: bigint
      amount: bigint
      escrow: bigint
      reason: DisburseFailedReason
    }
  | { name: "schedule_paused"; employer: string; schedule_id: bigint }
  | { name: "schedule_resumed"; employer: string; schedule_id: bigint; next_due: bigint }
  | { name: "schedule_cancelled"; employer: string; schedule_id: bigint }
  | { name: "fee_set"; fee_bps: number }
  | { name: "fee_recipient_set"; fee_recipient: string }
  | { name: "admin_proposed"; pending_admin: string }
  | { name: "admin_transferred"; new_admin: string; old_admin: string }
  | { name: "paused" }
  | { name: "unpaused" }
  | { name: "upgraded"; wasm_hash: string }

export type RubbiEvent =
  | ({ contract: "vault" } & VaultEvent)
  | ({ contract: "subscriptions" } & SubscriptionsEvent)
  | ({ contract: "payroll" } & PayrollEvent)

export class EventDecodeError extends Error {}

class Fields {
  constructor(private readonly event: DecodedEvent) {}

  private raw(field: string): unknown {
    return this.event.data[field]
  }

  /**
   * Every Rubbi event has at most one `#[topic]` field (the primary
   * address), emitted as topic 1; all other fields live in the data map.
   */
  topicAddress(field: string): string {
    return this.asAddress(field, this.event.topics[0])
  }

  private asAddress(field: string, value: unknown): string {
    if (typeof value === "string" && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) {
      return value
    }
    if (value instanceof Address) return value.toString()
    return this.fail(field, "an address")
  }

  private fail(field: string, expected: string): never {
    throw new EventDecodeError(
      `${this.event.contract ?? this.event.contractId}.${this.event.name}: field ${field} is not ${expected}`,
    )
  }

  address(field: string): string {
    return this.asAddress(field, this.raw(field))
  }

  i128(field: string): bigint {
    const value = this.raw(field)
    if (typeof value === "bigint") return value
    if (typeof value === "number" && Number.isInteger(value)) return BigInt(value)
    return this.fail(field, "an integer")
  }

  u64(field: string): bigint {
    return this.i128(field)
  }

  u32(field: string): number {
    const value = this.raw(field)
    if (typeof value === "number" && Number.isInteger(value)) return value
    if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
    return this.fail(field, "a u32")
  }

  bool(field: string): boolean {
    const value = this.raw(field)
    if (typeof value === "boolean") return value
    return this.fail(field, "a boolean")
  }

  string(field: string): string {
    const value = this.raw(field)
    if (typeof value === "string") return value
    if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8")
    return this.fail(field, "a string")
  }

  symbol<T extends string>(field: string, allowed: readonly T[]): T {
    const value = this.raw(field)
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T
    return this.fail(field, `one of ${allowed.join(", ")}`)
  }

  bytesHex(field: string): string {
    const value = this.raw(field)
    if (value instanceof Uint8Array) return Buffer.from(value).toString("hex")
    if (typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
    return this.fail(field, "32 bytes")
  }
}

const CHARGE_SKIPPED_REASONS = ["merchant_inactive", "payout_unavailable"] as const
const DISBURSE_FAILED_REASONS = ["insufficient_escrow", "recipient_unpayable"] as const

/**
 * Turns a decoded event of one of the three Rubbi contracts into its typed
 * form. Returns null for events of other contracts. Throws
 * `EventDecodeError` when a known event has an unexpected shape.
 */
export function toRubbiEvent(event: DecodedEvent): RubbiEvent | null {
  switch (event.contract) {
    case "vault":
      return { contract: "vault", ...decodeVault(event) }
    case "subscriptions":
      return { contract: "subscriptions", ...decodeSubscriptions(event) }
    case "payroll":
      return { contract: "payroll", ...decodePayroll(event) }
    default:
      return null
  }
}

function decodeAdmin(event: DecodedEvent, f: Fields) {
  switch (event.name) {
    case "admin_proposed":
      return { name: "admin_proposed" as const, pending_admin: f.topicAddress("pending_admin") }
    case "admin_transferred":
      return {
        name: "admin_transferred" as const,
        new_admin: f.topicAddress("new_admin"),
        old_admin: f.address("old_admin"),
      }
    case "paused":
      return { name: "paused" as const }
    case "unpaused":
      return { name: "unpaused" as const }
    case "upgraded":
      return { name: "upgraded" as const, wasm_hash: f.bytesHex("wasm_hash") }
    case "fee_set":
      return { name: "fee_set" as const, fee_bps: f.u32("fee_bps") }
    case "fee_recipient_set":
      return { name: "fee_recipient_set" as const, fee_recipient: f.address("fee_recipient") }
    default:
      return null
  }
}

function unknown(event: DecodedEvent): never {
  throw new EventDecodeError(`unknown ${event.contract} event: ${event.name}`)
}

function decodeVault(event: DecodedEvent): VaultEvent {
  const f = new Fields(event)
  switch (event.name) {
    case "deposit":
    case "withdraw":
      return { name: event.name, user: f.topicAddress("user"), amount: f.i128("amount") }
    case "card_spend_settled":
    case "refund_credited":
      return {
        name: event.name,
        user: f.topicAddress("user"),
        amount: f.i128("amount"),
        reference: f.bytesHex("reference"),
      }
    case "operator_set":
      return { name: "operator_set", operator: f.address("operator") }
    case "treasury_set":
      return { name: "treasury_set", treasury: f.address("treasury") }
    default: {
      const admin = decodeAdmin(event, f)
      if (admin && admin.name !== "fee_set" && admin.name !== "fee_recipient_set") return admin
      return unknown(event)
    }
  }
}

function decodeSubscriptions(event: DecodedEvent): SubscriptionsEvent {
  const f = new Fields(event)
  switch (event.name) {
    case "merchant_added":
      return { name: "merchant_added", merchant: f.topicAddress("merchant"), payout: f.address("payout") }
    case "merchant_active_set":
      return { name: "merchant_active_set", merchant: f.topicAddress("merchant"), active: f.bool("active") }
    case "plan_created":
      return {
        name: "plan_created",
        merchant: f.topicAddress("merchant"),
        plan_id: f.u32("plan_id"),
        plan_name: f.string("name"),
        amount: f.i128("amount"),
        period: f.u64("period"),
      }
    case "plan_active_set":
      return {
        name: "plan_active_set",
        merchant: f.topicAddress("merchant"),
        plan_id: f.u32("plan_id"),
        active: f.bool("active"),
      }
    case "subscribed":
      return {
        name: "subscribed",
        subscriber: f.topicAddress("subscriber"),
        sub_id: f.u64("sub_id"),
        plan_id: f.u32("plan_id"),
        next_due: f.u64("next_due"),
      }
    case "charged":
      return {
        name: "charged",
        subscriber: f.topicAddress("subscriber"),
        sub_id: f.u64("sub_id"),
        plan_id: f.u32("plan_id"),
        merchant: f.address("merchant"),
        amount: f.i128("amount"),
        fee: f.i128("fee"),
        next_due: f.u64("next_due"),
      }
    case "charge_failed":
      return {
        name: "charge_failed",
        subscriber: f.topicAddress("subscriber"),
        sub_id: f.u64("sub_id"),
        plan_id: f.u32("plan_id"),
        amount: f.i128("amount"),
      }
    case "charge_skipped":
      return {
        name: "charge_skipped",
        subscriber: f.topicAddress("subscriber"),
        sub_id: f.u64("sub_id"),
        reason: f.symbol("reason", CHARGE_SKIPPED_REASONS),
      }
    case "subscription_paused":
    case "subscription_cancelled":
      return { name: event.name, subscriber: f.topicAddress("subscriber"), sub_id: f.u64("sub_id") }
    case "subscription_resumed":
      return {
        name: "subscription_resumed",
        subscriber: f.topicAddress("subscriber"),
        sub_id: f.u64("sub_id"),
        next_due: f.u64("next_due"),
      }
    default:
      return decodeAdmin(event, f) ?? unknown(event)
  }
}

function decodePayroll(event: DecodedEvent): PayrollEvent {
  const f = new Fields(event)
  switch (event.name) {
    case "funded":
    case "escrow_withdrawn":
      return { name: event.name, employer: f.topicAddress("employer"), amount: f.i128("amount") }
    case "schedule_created":
      return {
        name: "schedule_created",
        employer: f.topicAddress("employer"),
        schedule_id: f.u64("schedule_id"),
        recipient: f.address("recipient"),
        amount: f.i128("amount"),
        period: f.u64("period"),
        next_due: f.u64("next_due"),
      }
    case "disbursed":
      return {
        name: "disbursed",
        employer: f.topicAddress("employer"),
        schedule_id: f.u64("schedule_id"),
        recipient: f.address("recipient"),
        amount: f.i128("amount"),
        fee: f.i128("fee"),
        next_due: f.u64("next_due"),
      }
    case "disburse_failed":
      return {
        name: "disburse_failed",
        employer: f.topicAddress("employer"),
        schedule_id: f.u64("schedule_id"),
        amount: f.i128("amount"),
        escrow: f.i128("escrow"),
        reason: f.symbol("reason", DISBURSE_FAILED_REASONS),
      }
    case "schedule_paused":
    case "schedule_cancelled":
      return { name: event.name, employer: f.topicAddress("employer"), schedule_id: f.u64("schedule_id") }
    case "schedule_resumed":
      return {
        name: "schedule_resumed",
        employer: f.topicAddress("employer"),
        schedule_id: f.u64("schedule_id"),
        next_due: f.u64("next_due"),
      }
    default:
      return decodeAdmin(event, f) ?? unknown(event)
  }
}
