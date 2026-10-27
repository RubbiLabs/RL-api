import { beforeAll, describe, expect, test } from "bun:test"
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { OTHER_ADDRESS, TEST_ENV, USER_ADDRESS, seedEnv } from "../helpers.js"

beforeAll(seedEnv)

type Field = [string, xdr.ScVal]

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const addr = (a: string) => new Address(a).toScVal()
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" })
const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" })
const u32 = (n: number) => nativeToScVal(n, { type: "u32" })
const str = (s: string) => nativeToScVal(s, { type: "string" })
const bytes32 = (fill: number) => nativeToScVal(Buffer.alloc(32, fill), { type: "bytes" })

/** Builds an RPC-shaped event the way `#[contractevent]` emits it. */
function rpcEvent(contractId: string, name: string, topicVals: xdr.ScVal[], data: Field[], id = "0001-1") {
  return {
    id,
    type: "contract" as const,
    ledger: 5_420_100,
    ledgerClosedAt: "2026-10-27T20:30:00Z",
    transactionIndex: 1,
    operationIndex: 0,
    txHash: "ab".repeat(32),
    contractId: new Contract(contractId),
    topic: [sym(name), ...topicVals],
    value: xdr.ScVal.scvMap(
      data.map(([key, val]) => new xdr.ScMapEntry({ key: sym(key), val })),
    ),
  }
}

describe("decodeRpcEvent", () => {
  test("reads the name from topic 0, the address from topic 1 and the data map", async () => {
    const { decodeRpcEvent } = await import("../../src/lib/stellar/events.js")
    const decoded = decodeRpcEvent(
      rpcEvent(TEST_ENV.VAULT_CONTRACT_ID, "deposit", [addr(USER_ADDRESS)], [["amount", i128(250_000_000n)]]),
    )
    expect(decoded.contract).toBe("vault")
    expect(decoded.name).toBe("deposit")
    expect(decoded.topics).toEqual([USER_ADDRESS])
    expect(decoded.data).toEqual({ amount: 250_000_000n })
    expect(decoded.ledger).toBe(5_420_100)
  })

  test("marks events of unknown contracts", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    const decoded = decodeRpcEvent(
      rpcEvent(TEST_ENV.USDC_SAC_ID, "transfer", [addr(USER_ADDRESS), addr(OTHER_ADDRESS)], []),
    )
    expect(decoded.contract).toBeNull()
    expect(toRubbiEvent(decoded)).toBeNull()
  })

  test("decodes an empty data map (paused / unpaused)", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    const decoded = decodeRpcEvent(rpcEvent(TEST_ENV.VAULT_CONTRACT_ID, "paused", [], []))
    expect(decoded.data).toEqual({})
    expect(toRubbiEvent(decoded)).toEqual({ contract: "vault", name: "paused" })
  })
})

describe("vault events", () => {
  test("card_spend_settled and refund_credited carry the reference as hex", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    for (const name of ["card_spend_settled", "refund_credited"] as const) {
      const ev = toRubbiEvent(
        decodeRpcEvent(
          rpcEvent(TEST_ENV.VAULT_CONTRACT_ID, name, [addr(USER_ADDRESS)], [
            ["amount", i128(50_000_000n)],
            ["reference", bytes32(0xab)],
          ]),
        ),
      )
      expect(ev).toEqual({
        contract: "vault",
        name,
        user: USER_ADDRESS,
        amount: 50_000_000n,
        reference: "ab".repeat(32),
      })
    }
  })

  test("withdraw, role rotation, admin transfer and upgrade", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    const vault = TEST_ENV.VAULT_CONTRACT_ID
    expect(
      toRubbiEvent(decodeRpcEvent(rpcEvent(vault, "withdraw", [addr(USER_ADDRESS)], [["amount", i128(1n)]]))),
    ).toEqual({ contract: "vault", name: "withdraw", user: USER_ADDRESS, amount: 1n })
    expect(
      toRubbiEvent(decodeRpcEvent(rpcEvent(vault, "operator_set", [], [["operator", addr(OTHER_ADDRESS)]]))),
    ).toEqual({ contract: "vault", name: "operator_set", operator: OTHER_ADDRESS })
    expect(
      toRubbiEvent(
        decodeRpcEvent(
          rpcEvent(vault, "admin_transferred", [addr(OTHER_ADDRESS)], [["old_admin", addr(USER_ADDRESS)]]),
        ),
      ),
    ).toEqual({ contract: "vault", name: "admin_transferred", new_admin: OTHER_ADDRESS, old_admin: USER_ADDRESS })
    expect(
      toRubbiEvent(decodeRpcEvent(rpcEvent(vault, "upgraded", [], [["wasm_hash", bytes32(0x01)]]))),
    ).toEqual({ contract: "vault", name: "upgraded", wasm_hash: "01".repeat(32) })
  })

  test("rejects a malformed known event", async () => {
    const { decodeRpcEvent, toRubbiEvent, EventDecodeError } = await import("../../src/lib/stellar/events.js")
    const bad = decodeRpcEvent(
      rpcEvent(TEST_ENV.VAULT_CONTRACT_ID, "deposit", [addr(USER_ADDRESS)], [["amount", str("ten")]]),
    )
    expect(() => toRubbiEvent(bad)).toThrow(EventDecodeError)
  })

  test("rejects an unknown event name of a known contract", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    const bad = decodeRpcEvent(rpcEvent(TEST_ENV.VAULT_CONTRACT_ID, "minted", [], []))
    expect(() => toRubbiEvent(bad)).toThrow("unknown vault event: minted")
  })
})

describe("subscriptions events", () => {
  const subs = TEST_ENV.SUBSCRIPTIONS_CONTRACT_ID

  test("plan_created, subscribed and charged", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    expect(
      toRubbiEvent(
        decodeRpcEvent(
          rpcEvent(subs, "plan_created", [addr(OTHER_ADDRESS)], [
            ["plan_id", u32(3)],
            ["name", str("Pro plan")],
            ["amount", i128(99_000_000n)],
            ["period", u64(2_592_000n)],
          ]),
        ),
      ),
    ).toEqual({
      contract: "subscriptions",
      name: "plan_created",
      merchant: OTHER_ADDRESS,
      plan_id: 3,
      plan_name: "Pro plan",
      amount: 99_000_000n,
      period: 2_592_000n,
    })

    expect(
      toRubbiEvent(
        decodeRpcEvent(
          rpcEvent(subs, "subscribed", [addr(USER_ADDRESS)], [
            ["sub_id", u64(11n)],
            ["plan_id", u32(3)],
            ["next_due", u64(1_764_192_000n)],
          ]),
        ),
      ),
    ).toEqual({
      contract: "subscriptions",
      name: "subscribed",
      subscriber: USER_ADDRESS,
      sub_id: 11n,
      plan_id: 3,
      next_due: 1_764_192_000n,
    })

    expect(
      toRubbiEvent(
        decodeRpcEvent(
          rpcEvent(subs, "charged", [addr(USER_ADDRESS)], [
            ["sub_id", u64(11n)],
            ["plan_id", u32(3)],
            ["merchant", addr(OTHER_ADDRESS)],
            ["amount", i128(99_000_000n)],
            ["fee", i128(495_000n)],
            ["next_due", u64(1_766_784_000n)],
          ]),
        ),
      ),
    ).toMatchObject({ name: "charged", merchant: OTHER_ADDRESS, fee: 495_000n, sub_id: 11n })
  })

  test("charge_failed and charge_skipped with both reasons", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    expect(
      toRubbiEvent(
        decodeRpcEvent(
          rpcEvent(subs, "charge_failed", [addr(USER_ADDRESS)], [
            ["sub_id", u64(11n)],
            ["plan_id", u32(3)],
            ["amount", i128(99_000_000n)],
          ]),
        ),
      ),
    ).toEqual({
      contract: "subscriptions",
      name: "charge_failed",
      subscriber: USER_ADDRESS,
      sub_id: 11n,
      plan_id: 3,
      amount: 99_000_000n,
    })

    for (const reason of ["merchant_inactive", "payout_unavailable"]) {
      expect(
        toRubbiEvent(
          decodeRpcEvent(
            rpcEvent(subs, "charge_skipped", [addr(USER_ADDRESS)], [
              ["sub_id", u64(11n)],
              ["reason", sym(reason)],
            ]),
          ),
        ),
      ).toEqual({ contract: "subscriptions", name: "charge_skipped", subscriber: USER_ADDRESS, sub_id: 11n, reason })
    }

    const unknownReason = decodeRpcEvent(
      rpcEvent(subs, "charge_skipped", [addr(USER_ADDRESS)], [
        ["sub_id", u64(11n)],
        ["reason", sym("solar_flare")],
      ]),
    )
    expect(() => toRubbiEvent(unknownReason)).toThrow(/reason is not one of/)
  })

  test("lifecycle, merchant and fee events", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    expect(
      toRubbiEvent(
        decodeRpcEvent(
          rpcEvent(subs, "subscription_resumed", [addr(USER_ADDRESS)], [
            ["sub_id", u64(11n)],
            ["next_due", u64(1_764_192_000n)],
          ]),
        ),
      ),
    ).toMatchObject({ name: "subscription_resumed", next_due: 1_764_192_000n })
    expect(
      toRubbiEvent(decodeRpcEvent(rpcEvent(subs, "subscription_cancelled", [addr(USER_ADDRESS)], [["sub_id", u64(11n)]]))),
    ).toEqual({ contract: "subscriptions", name: "subscription_cancelled", subscriber: USER_ADDRESS, sub_id: 11n })
    expect(
      toRubbiEvent(decodeRpcEvent(rpcEvent(subs, "merchant_active_set", [addr(OTHER_ADDRESS)], [["active", nativeToScVal(false)]]))),
    ).toEqual({ contract: "subscriptions", name: "merchant_active_set", merchant: OTHER_ADDRESS, active: false })
    expect(toRubbiEvent(decodeRpcEvent(rpcEvent(subs, "fee_set", [], [["fee_bps", u32(75)]])))).toEqual({
      contract: "subscriptions",
      name: "fee_set",
      fee_bps: 75,
    })
  })
})

describe("payroll events", () => {
  const payroll = TEST_ENV.PAYROLL_CONTRACT_ID

  test("schedule_created has no label", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    const ev = toRubbiEvent(
      decodeRpcEvent(
        rpcEvent(payroll, "schedule_created", [addr(OTHER_ADDRESS)], [
          ["schedule_id", u64(5n)],
          ["recipient", addr(USER_ADDRESS)],
          ["amount", i128(1_500_000_000n)],
          ["period", u64(2_592_000n)],
          ["next_due", u64(1_764_192_000n)],
        ]),
      ),
    )
    expect(ev).toEqual({
      contract: "payroll",
      name: "schedule_created",
      employer: OTHER_ADDRESS,
      schedule_id: 5n,
      recipient: USER_ADDRESS,
      amount: 1_500_000_000n,
      period: 2_592_000n,
      next_due: 1_764_192_000n,
    })
    expect(ev && "label" in ev).toBe(false)
  })

  test("disbursed and disburse_failed with both reasons", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    expect(
      toRubbiEvent(
        decodeRpcEvent(
          rpcEvent(payroll, "disbursed", [addr(OTHER_ADDRESS)], [
            ["schedule_id", u64(5n)],
            ["recipient", addr(USER_ADDRESS)],
            ["amount", i128(1_500_000_000n)],
            ["fee", i128(7_500_000n)],
            ["next_due", u64(1_766_784_000n)],
          ]),
        ),
      ),
    ).toMatchObject({ name: "disbursed", schedule_id: 5n, fee: 7_500_000n, recipient: USER_ADDRESS })

    for (const reason of ["insufficient_escrow", "recipient_unpayable"]) {
      expect(
        toRubbiEvent(
          decodeRpcEvent(
            rpcEvent(payroll, "disburse_failed", [addr(OTHER_ADDRESS)], [
              ["schedule_id", u64(5n)],
              ["amount", i128(1_500_000_000n)],
              ["escrow", i128(20_000_000n)],
              ["reason", sym(reason)],
            ]),
          ),
        ),
      ).toEqual({
        contract: "payroll",
        name: "disburse_failed",
        employer: OTHER_ADDRESS,
        schedule_id: 5n,
        amount: 1_500_000_000n,
        escrow: 20_000_000n,
        reason,
      })
    }
  })

  test("funded, escrow_withdrawn and schedule lifecycle", async () => {
    const { decodeRpcEvent, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    expect(toRubbiEvent(decodeRpcEvent(rpcEvent(payroll, "funded", [addr(OTHER_ADDRESS)], [["amount", i128(5n)]])))).toEqual({
      contract: "payroll",
      name: "funded",
      employer: OTHER_ADDRESS,
      amount: 5n,
    })
    expect(
      toRubbiEvent(decodeRpcEvent(rpcEvent(payroll, "escrow_withdrawn", [addr(OTHER_ADDRESS)], [["amount", i128(5n)]]))),
    ).toMatchObject({ name: "escrow_withdrawn", amount: 5n })
    expect(
      toRubbiEvent(
        decodeRpcEvent(
          rpcEvent(payroll, "schedule_resumed", [addr(OTHER_ADDRESS)], [
            ["schedule_id", u64(5n)],
            ["next_due", u64(1_764_192_000n)],
          ]),
        ),
      ),
    ).toMatchObject({ name: "schedule_resumed", schedule_id: 5n, next_due: 1_764_192_000n })
    expect(
      toRubbiEvent(decodeRpcEvent(rpcEvent(payroll, "schedule_cancelled", [addr(OTHER_ADDRESS)], [["schedule_id", u64(5n)]]))),
    ).toEqual({ contract: "payroll", name: "schedule_cancelled", employer: OTHER_ADDRESS, schedule_id: 5n })
  })
})

describe("decodeContractEventXdr", () => {
  test("decodes a ContractEvent from a transaction result the same way", async () => {
    const { decodeContractEventXdr, toRubbiEvent } = await import("../../src/lib/stellar/events.js")
    const { StrKey } = await import("@stellar/stellar-sdk")
    const event = new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: new xdr.ContractId(StrKey.decodeContract(TEST_ENV.PAYROLL_CONTRACT_ID)),
      type: xdr.ContractEventType.contract,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({
          topics: [sym("disburse_failed"), addr(OTHER_ADDRESS)],
          data: xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: sym("schedule_id"), val: u64(5n) }),
            new xdr.ScMapEntry({ key: sym("amount"), val: i128(10n) }),
            new xdr.ScMapEntry({ key: sym("escrow"), val: i128(1n) }),
            new xdr.ScMapEntry({ key: sym("reason"), val: sym("recipient_unpayable") }),
          ]),
        }),
      ),
    })
    const decoded = decodeContractEventXdr(event, { txHash: "cd".repeat(32), ledger: 7 })
    expect(decoded.contract).toBe("payroll")
    expect(toRubbiEvent(decoded)).toMatchObject({ name: "disburse_failed", reason: "recipient_unpayable", schedule_id: 5n })
  })
})
