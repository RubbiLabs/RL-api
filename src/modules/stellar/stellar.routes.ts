import { FastifyInstance } from "fastify"

import { env } from "../../config/index.js"

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
}
