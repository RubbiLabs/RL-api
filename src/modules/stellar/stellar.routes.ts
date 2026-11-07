import { FastifyInstance } from "fastify"
import {
  Address,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk"

import { env } from "../../config/index.js"
import { getFeeSponsorKeypair, rpcServer } from "../../lib/stellar/client.js"

/** Public network configuration (ids and URLs only; never secrets). */
export function publicStellarConfig() {
  return {
    network: env.STELLAR_NETWORK,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
    rpcUrl: env.STELLAR_RPC_URL,
    usdcSacId: env.USDC_SAC_ID,
    contracts: {
      vault: env.VAULT_CONTRACT_ID,
      subscriptions: env.SUBSCRIPTIONS_CONTRACT_ID,
      payroll: env.PAYROLL_CONTRACT_ID,
    },
    sep10: {
      homeDomain: env.HOME_DOMAIN,
      webAuthDomain: env.WEB_AUTH_DOMAIN,
    },
  }
}

const ALLOWED_FUNCTIONS_BY_CONTRACT: Record<string, string[]> = {
  [env.USDC_SAC_ID]: ["deposit", "withdraw", "approve"],
  [env.VAULT_CONTRACT_ID]: ["deposit", "withdraw", "load_card", "unload_card"],
  [env.SUBSCRIPTIONS_CONTRACT_ID]: [
    "subscribe",
    "pause_subscription",
    "resume_subscription",
    "cancel_subscription",
    "propose_plan_price",
    "accept_plan_price",
  ],
  [env.PAYROLL_CONTRACT_ID]: [
    "fund",
    "withdraw_escrow",
    "create_schedules",
    "pause_schedule",
    "resume_schedule",
    "cancel_schedule",
    "disburse_batch",
  ],
}

// In-memory counter fallback for daily sponsorship limits in tests
const memoryDailyCounters = new Map<string, number>()

async function incrementDailyCount(app: FastifyInstance, account: string): Promise<number> {
  const dateKey = new Date().toISOString().slice(0, 10)
  const key = `sponsor:daily:${account}:${dateKey}`
  if ((app as any).redis && typeof (app as any).redis.incr === "function") {
    const count = Number(await (app as any).redis.incr(key))
    if (count === 1 && typeof (app as any).redis.expire === "function") {
      await (app as any).redis.expire(key, 86400)
    }
    return count
  }
  const current = (memoryDailyCounters.get(key) ?? 0) + 1
  memoryDailyCounters.set(key, current)
  return current
}

export async function registerStellarRoutes(app: FastifyInstance) {
  app.get("/stellar/config", {
    schema: {
      tags: ["stellar"],
      description: "Network, USDC SAC and contract ids this backend indexes (public)",
      response: {
        200: {
          type: "object",
          properties: {
            network: { type: "string" },
            networkPassphrase: { type: "string" },
            rpcUrl: { type: "string" },
            usdcSacId: { type: "string" },
            contracts: {
              type: "object",
              properties: {
                vault: { type: "string" },
                subscriptions: { type: "string" },
                payroll: { type: "string" },
              },
            },
            sep10: {
              type: "object",
              properties: { homeDomain: { type: "string" }, webAuthDomain: { type: "string" } },
            },
          },
        },
      },
    },
    handler: async (_request, reply) => reply.send(publicStellarConfig()),
  })

  // Sponsoring route is registered only if FEE_SPONSOR_SECRET is configured
  // or responds with 404 if unset
  app.post("/stellar/sponsor", {
    schema: {
      tags: ["stellar"],
      summary: "Sponsor a transaction with a fee-bump",
      description:
        "Wraps an inner transaction in a fee-bump transaction signed by the sponsor account. " +
        "Only allowlisted Rubbi contract interactions and USDC change_trust are permitted.",
      body: {
        type: "object",
        required: ["transaction"],
        properties: {
          transaction: { type: "string", description: "Signed inner transaction XDR" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            hash: { type: "string" },
            transaction: { type: "string" },
            submitted: { type: "boolean" },
          },
        },
      },
    },
    onRequest: [app.authenticate],
    handler: async (request, reply) => {
      const sponsorKey = getFeeSponsorKeypair()
      if (!sponsorKey) {
        throw app.httpErrors.notFound("Fee sponsorship is not configured")
      }

      const userAddress = (request.user as any)?.sub
      if (!userAddress) {
        throw app.httpErrors.unauthorized("Authentication required")
      }

      const { transaction: txXdr } = request.body as { transaction: string }

      // 1. Parse inner transaction
      let innerTx: Transaction
      try {
        const parsed = TransactionBuilder.fromXDR(txXdr, env.STELLAR_NETWORK_PASSPHRASE)
        if (!(parsed instanceof Transaction)) {
          throw new Error("Expected standard Transaction envelope")
        }
        innerTx = parsed
      } catch (err) {
        throw app.httpErrors.badRequest("Invalid inner transaction XDR")
      }

      // 2. Reject anything but single operation
      if (innerTx.operations.length !== 1) {
        throw app.httpErrors.badRequest("Transaction must contain exactly one operation")
      }

      // 3. Verify inner source account matches JWT sub
      if (innerTx.source !== userAddress) {
        throw app.httpErrors.badRequest("Inner transaction source does not match authenticated user")
      }

      const op = innerTx.operations[0]!
      if (op.source && op.source !== userAddress) {
        throw app.httpErrors.badRequest("Operation source does not match authenticated user")
      }

      // 4. Validate operation allowlist
      let contractTarget = "USDC"
      let functionTarget = "change_trust"

      if (op.type === "changeTrust") {
        const line = (op as any).line
        if (line?.code !== "USDC") {
          throw app.httpErrors.badRequest("change_trust is only sponsored for USDC asset")
        }
      } else if (op.type === "invokeHostFunction") {
        const hostFn = (op as any).func as xdr.HostFunction
        if (hostFn.switch().value !== xdr.HostFunctionType.hostFunctionTypeInvokeContract().value) {
          throw app.httpErrors.badRequest("Only invokeContract host functions are allowed")
        }
        const invokeContract = hostFn.invokeContract()
        const contractAddress = Address.fromScAddress(invokeContract.contractAddress()).toString()
        const functionName = invokeContract.functionName().toString()
        const args = invokeContract.args()

        contractTarget = contractAddress
        functionTarget = functionName

        const allowedFunctions = ALLOWED_FUNCTIONS_BY_CONTRACT[contractAddress]
        if (!allowedFunctions) {
          throw app.httpErrors.badRequest("Contract is not in the sponsored allowlist")
        }

        if (!allowedFunctions.includes(functionName)) {
          throw app.httpErrors.badRequest(`Function '${functionName}' is not in the sponsored allowlist`)
        }

        // approve requires spender to be the subscriptions contract
        if (contractAddress === env.USDC_SAC_ID && functionName === "approve") {
          if (args.length < 2) {
            throw app.httpErrors.badRequest("Invalid arguments for approve")
          }
          const spenderAddress = Address.fromScVal(args[1]!).toString()
          if (spenderAddress !== env.SUBSCRIPTIONS_CONTRACT_ID) {
            throw app.httpErrors.badRequest("Approve spender must be the subscriptions contract")
          }
        }
      } else {
        throw app.httpErrors.badRequest(`Operation type '${op.type}' is not allowed for fee sponsorship`)
      }

      // 5. Check fee cap
      if (Number(innerTx.fee) > env.FEE_SPONSOR_MAX_FEE_STROOPS) {
        throw app.httpErrors.badRequest("Inner transaction fee exceeds maximum sponsored fee")
      }

      // 6. Check daily counter per account
      const dailyCount = await incrementDailyCount(app, userAddress)
      if (dailyCount > env.FEE_SPONSOR_DAILY_LIMIT_PER_ACCOUNT) {
        throw app.httpErrors.tooManyRequests("Daily fee sponsorship limit exceeded for account")
      }

      // 7. Build fee-bump transaction
      const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        sponsorKey.publicKey(),
        Math.max(Number(innerTx.fee) + 100, env.FEE_SPONSOR_MAX_FEE_STROOPS),
        innerTx,
        env.STELLAR_NETWORK_PASSPHRASE,
      )
      feeBump.sign(sponsorKey)
      const hash = feeBump.hash().toString("hex")

      // Attempt submit via RPC if reachable
      let submitted = false
      try {
        const sendRes = await rpcServer.sendTransaction(feeBump)
        if (sendRes.status !== "ERROR") {
          submitted = true
        }
      } catch {
        // Returned for client submission when offline or in test environments
      }

      app.log.info(
        { account: userAddress, contract: contractTarget, function: functionTarget, hash },
        "sponsored fee-bump transaction",
      )

      return reply.send({
        hash,
        transaction: feeBump.toXDR(),
        submitted,
      })
    },
  })
}
