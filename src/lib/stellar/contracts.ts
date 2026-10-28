import { contractIds } from "./client.js"
import { arg, enumName, simulateRead } from "./tx.js"

/** `payroll.get_schedule(id)` as stored on-chain (amounts in stroops). */
export interface OnChainSchedule {
  id: bigint
  employer: string
  recipient: string
  amount: bigint
  period: bigint
  next_due: bigint
  status: "Active" | "Paused" | "Cancelled"
  label: string
  created_at: bigint
}

export interface OnChainPlan {
  id: number
  merchant: string
  name: string
  amount: bigint
  period: bigint
  active: boolean
}

export interface OnChainSubscription {
  id: bigint
  subscriber: string
  plan_id: number
  next_due: bigint
  status: "Active" | "Paused" | "PastDue" | "Cancelled"
  created_at: bigint
}

type Raw = Record<string, unknown>

export async function getSchedule(scheduleId: bigint): Promise<OnChainSchedule> {
  const raw = await simulateRead<Raw>({
    contractId: contractIds.payroll,
    method: "get_schedule",
    args: [arg.u64(scheduleId)],
  })
  return {
    id: BigInt(raw.id as bigint),
    employer: String(raw.employer),
    recipient: String(raw.recipient),
    amount: BigInt(raw.amount as bigint),
    period: BigInt(raw.period as bigint),
    next_due: BigInt(raw.next_due as bigint),
    status: enumName(raw.status) as OnChainSchedule["status"],
    label: String(raw.label),
    created_at: BigInt(raw.created_at as bigint),
  }
}

export async function getPlan(planId: number): Promise<OnChainPlan> {
  const raw = await simulateRead<Raw>({
    contractId: contractIds.subscriptions,
    method: "get_plan",
    args: [arg.u32(planId)],
  })
  return {
    id: Number(raw.id),
    merchant: String(raw.merchant),
    name: String(raw.name),
    amount: BigInt(raw.amount as bigint),
    period: BigInt(raw.period as bigint),
    active: Boolean(raw.active),
  }
}

export async function getSubscription(subId: bigint): Promise<OnChainSubscription> {
  const raw = await simulateRead<Raw>({
    contractId: contractIds.subscriptions,
    method: "get_subscription",
    args: [arg.u64(subId)],
  })
  return {
    id: BigInt(raw.id as bigint),
    subscriber: String(raw.subscriber),
    plan_id: Number(raw.plan_id),
    next_due: BigInt(raw.next_due as bigint),
    status: enumName(raw.status) as OnChainSubscription["status"],
    created_at: BigInt(raw.created_at as bigint),
  }
}

export async function vaultBalance(user: string): Promise<bigint> {
  const raw = await simulateRead<bigint>({
    contractId: contractIds.vault,
    method: "balance",
    args: [arg.address(user)],
  })
  return BigInt(raw)
}
