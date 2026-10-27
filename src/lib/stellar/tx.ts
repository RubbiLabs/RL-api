import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk"

import { contractNameOf, getKeeperKeypair, networkPassphrase, rpcServer } from "./client.js"
import { contractErrorName } from "./errors.js"
import { decodeContractEventXdr, type DecodedEvent } from "./events.js"

// ---------------------------------------------------------------------------
// Argument builders (explicit XDR types; never rely on JS number inference).

export const arg = {
  address: (value: string) => new Address(value).toScVal(),
  i128: (value: bigint) => nativeToScVal(value, { type: "i128" }),
  u64: (value: bigint) => nativeToScVal(value, { type: "u64" }),
  u32: (value: number) => nativeToScVal(value, { type: "u32" }),
  bool: (value: boolean) => nativeToScVal(value),
  string: (value: string) => nativeToScVal(value, { type: "string" }),
  symbol: (value: string) => nativeToScVal(value, { type: "symbol" }),
  bytes32: (hex: string) => {
    const bytes = Buffer.from(hex, "hex")
    if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`)
    return nativeToScVal(bytes, { type: "bytes" })
  },
  u64Vec: (values: bigint[]) => xdr.ScVal.scvVec(values.map((v) => nativeToScVal(v, { type: "u64" }))),
}

/** The simulation of a contract call failed (a contract error or a host error). */
export class SimulationFailed extends Error {
  readonly errorName: string | null

  constructor(
    readonly contractId: string,
    readonly method: string,
    readonly rpcError: string,
  ) {
    const contract = contractNameOf(contractId)
    const errorName = contract ? contractErrorName(contract, rpcError) : null
    super(`simulation of ${contract ?? contractId}.${method} failed: ${errorName ?? rpcError}`)
    this.errorName = errorName
  }
}

/** The transaction was submitted but did not succeed, or could not be submitted. */
export class TransactionFailed extends Error {
  constructor(
    readonly contractId: string,
    readonly method: string,
    readonly status: string,
    readonly hash: string | null,
    detail?: string,
  ) {
    super(
      `${contractNameOf(contractId) ?? contractId}.${method} ${status}${hash ? ` (${hash})` : ""}${detail ? `: ${detail}` : ""}`,
    )
  }
}

/** Temporary RPC condition (TRY_AGAIN_LATER, timeouts); safe to retry. */
export class TransactionRetryable extends TransactionFailed {}

export interface CallSpec {
  contractId: string
  method: string
  args: xdr.ScVal[]
}

export interface InvokeResult {
  hash: string
  ledger: number
  returnValue: unknown
  events: DecodedEvent[]
}

/** Normalises a unit enum variant (`["Active"]`) to its name. */
export function enumName(value: unknown): string {
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0]
  if (typeof value === "string") return value
  throw new Error(`not an enum variant: ${JSON.stringify(value)}`)
}

function buildTx(source: Account, call: CallSpec, timeoutSeconds: number) {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(call.contractId).call(call.method, ...call.args))
    .setTimeout(timeoutSeconds)
    .build()
}

/**
 * Simulates a read-only contract call and returns its native return value.
 * No account lookup and nothing is signed or submitted: the keeper's public
 * key is used as the (unverified) source of the simulated transaction.
 */
export async function simulateRead<T = unknown>(
  call: CallSpec,
  source: string = getKeeperKeypair().publicKey(),
): Promise<T> {
  const tx = buildTx(new Account(source, "0"), call, 60)
  const sim = await rpcServer.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new SimulationFailed(call.contractId, call.method, sim.error)
  }
  if (!sim.result) {
    throw new Error(`simulation of ${call.method} returned no result`)
  }
  return scValToNative(sim.result.retval) as T
}

/** Simulates `call` as `source` and returns the raw simulation response. */
export async function simulateCall(call: CallSpec, source: Keypair) {
  const account = await rpcServer.getAccount(source.publicKey())
  const tx = buildTx(account, call, 60)
  const sim = await rpcServer.simulateTransaction(tx)
  return { tx, sim }
}

/**
 * Builds, simulates, assembles, signs, submits and polls a contract call.
 *
 * Throws `SimulationFailed` when the simulation fails (nothing is sent),
 * `TransactionRetryable` when the RPC asks to try again later, and
 * `TransactionFailed` when the network rejects or fails the transaction.
 */
export async function invoke(
  call: CallSpec,
  signer: Keypair,
  options: { timeoutSeconds?: number; pollAttempts?: number } = {},
): Promise<InvokeResult> {
  const { tx, sim } = await simulateCall(call, signer)

  if (rpc.Api.isSimulationError(sim)) {
    throw new SimulationFailed(call.contractId, call.method, sim.error)
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new TransactionFailed(
      call.contractId,
      call.method,
      "RESTORE_REQUIRED",
      null,
      "archived ledger entries must be restored first (extend the contract TTLs)",
    )
  }

  const prepared = rpc.assembleTransaction(tx, sim).setTimeout(options.timeoutSeconds ?? 60).build()
  prepared.sign(signer)

  const sent = await rpcServer.sendTransaction(prepared)
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new TransactionRetryable(call.contractId, call.method, sent.status, sent.hash)
  }
  if (sent.status === "ERROR") {
    const detail = sent.errorResult ? sent.errorResult.toXDR("base64") : undefined
    throw new TransactionFailed(call.contractId, call.method, sent.status, sent.hash, detail)
  }

  const result = await rpcServer.pollTransaction(sent.hash, {
    attempts: options.pollAttempts ?? 30,
  })

  if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw new TransactionRetryable(call.contractId, call.method, "NOT_FOUND", sent.hash)
  }
  if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new TransactionFailed(
      call.contractId,
      call.method,
      "FAILED",
      sent.hash,
      result.resultXdr.toXDR("base64"),
    )
  }

  const events = (result.events?.contractEventsXdr ?? [])
    .flat()
    .map((event, index) =>
      decodeContractEventXdr(event, {
        txHash: sent.hash,
        ledger: result.ledger,
        id: `${sent.hash}:${index}`,
      }),
    )

  return {
    hash: sent.hash,
    ledger: result.ledger,
    returnValue: result.returnValue ? scValToNative(result.returnValue) : undefined,
    events,
  }
}
