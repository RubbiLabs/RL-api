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
  chargeBatch(subIds: bigint[], options?: { dryRun?: boolean }): Promise<BatchOutcome>
  charge(subId: bigint, options?: { dryRun?: boolean }): Promise<BatchOutcome>
  disburseBatch(ids: bigint[], options?: { dryRun?: boolean }): Promise<BatchOutcome>
  disburse(id: bigint, options?: { dryRun?: boolean }): Promise<BatchOutcome>
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

export function makeKeeperChain(defaultOptions: { dryRun?: boolean } = {}): KeeperChain {
  const signer = getKeeperKeypair()

  async function executeCall(call: CallSpec, count: number, options?: { dryRun?: boolean }): Promise<BatchOutcome> {
    const dryRun = options?.dryRun ?? defaultOptions.dryRun ?? false
    if (dryRun) {
      const { sim } = await simulateCall(call, signer)
      if (rpc.Api.isSimulationError(sim)) {
        throw new SimulationFailed(call.contractId, call.method, sim.error)
      }
      if (!sim.result) {
        throw new Error(`simulation of ${call.method} returned no result`)
      }
      const returnValue = scValToNative(sim.result.retval)
      const events: RubbiEvent[] = []
      if (sim.events) {
        for (const rawEvent of sim.events) {
          try {
            const decoded = decodeContractEventXdr(rawEvent)
            const event = toRubbiEvent(decoded)
            if (event) events.push(event)
          } catch {
            // Unknown event shapes are safely ignored during simulation
          }
        }
      }
      const results = Array.isArray(returnValue) ? returnValue.map(Boolean) : [Boolean(returnValue)]
      return { hash: "dry_run", results, events }
    }

    return outcomeOf(await invoke(call, signer), count)
  }

  return {
    chargeBatch: (subIds, opts) =>
      executeCall({ contractId: contractIds.subscriptions, method: "charge_batch", args: [arg.u64Vec(subIds)] }, subIds.length, opts),
    charge: (subId, opts) =>
      executeCall({ contractId: contractIds.subscriptions, method: "charge", args: [arg.u64(subId)] }, 1, opts),
    disburseBatch: (ids, opts) =>
      executeCall({ contractId: contractIds.payroll, method: "disburse_batch", args: [arg.u64Vec(ids)] }, ids.length, opts),
    disburse: (id, opts) =>
      executeCall({ contractId: contractIds.payroll, method: "disburse", args: [arg.u64(id)] }, 1, opts),
  }
}
