import { contractIds, getKeeperKeypair } from "./client.js"
import { toRubbiEvent, type RubbiEvent } from "./events.js"
import { arg, invoke } from "./tx.js"

/** Outcome of one charge / disburse call: per-item booleans plus the events. */
export interface BatchOutcome {
  hash: string
  results: boolean[]
  events: RubbiEvent[]
}

/** The keeper's on-chain calls, all signed by KEEPER_SECRET. */
export interface KeeperChain {
  chargeBatch(subIds: bigint[]): Promise<BatchOutcome>
  charge(subId: bigint): Promise<BatchOutcome>
  disburseBatch(ids: bigint[]): Promise<BatchOutcome>
  disburse(id: bigint): Promise<BatchOutcome>
}

function outcomeOf(result: { hash: string; returnValue: unknown; events: { contract: unknown }[] }, count: number): BatchOutcome {
  const value = result.returnValue
  const results = Array.isArray(value) ? value.map(Boolean) : [Boolean(value)]
  if (results.length !== count) {
    throw new Error(`expected ${count} results, got ${results.length}`)
  }
  const events: RubbiEvent[] = []
  for (const decoded of result.events as Parameters<typeof toRubbiEvent>[0][]) {
    try {
      const event = toRubbiEvent(decoded)
      if (event) events.push(event)
    } catch {
      // Unknown shapes are not the keeper's concern; the indexer reports them.
    }
  }
  return { hash: result.hash, results, events }
}

export function makeKeeperChain(): KeeperChain {
  const signer = getKeeperKeypair()
  return {
    chargeBatch: async (subIds) =>
      outcomeOf(
        await invoke({ contractId: contractIds.subscriptions, method: "charge_batch", args: [arg.u64Vec(subIds)] }, signer),
        subIds.length,
      ),
    charge: async (subId) =>
      outcomeOf(await invoke({ contractId: contractIds.subscriptions, method: "charge", args: [arg.u64(subId)] }, signer), 1),
    disburseBatch: async (ids) =>
      outcomeOf(
        await invoke({ contractId: contractIds.payroll, method: "disburse_batch", args: [arg.u64Vec(ids)] }, signer),
        ids.length,
      ),
    disburse: async (id) =>
      outcomeOf(await invoke({ contractId: contractIds.payroll, method: "disburse", args: [arg.u64(id)] }, signer), 1),
  }
}
