import { FastifyInstance } from "fastify"

import { buildAuthController } from "./auth.controller.js"

export async function registerAuthRoutes(app: FastifyInstance) {
  const controller = buildAuthController(app)

  app.get("/auth/challenge", {
    config: {
      rateLimit: { max: 30, timeWindow: "1 minute" },
    },
    schema: {
      tags: ["auth"],
      summary: "SEP-10 challenge",
      description:
        "Returns a SEP-10 challenge transaction (base64 XDR) for the given Stellar account. " +
        "Sign it with the account's key and POST it to /auth/token. Contract accounts (C...) " +
        "need SEP-45, which is not implemented yet.",
      querystring: {
        type: "object",
        required: ["account"],
        properties: {
          account: { type: "string", description: "Stellar account id (G...)" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            transaction: { type: "string" },
            network_passphrase: { type: "string" },
          },
        },
      },
    },
    handler: controller.challenge,
  })

  app.post("/auth/token", {
    config: {
      rateLimit: { max: 30, timeWindow: "1 minute" },
    },
    schema: {
      tags: ["auth"],
      summary: "SEP-10 token",
      description:
        "Verifies the signed challenge (server signature, time bounds, home domain, web auth " +
        "domain, client signature) and returns a JWT whose `sub` is the Stellar account id.",
      body: {
        type: "object",
        required: ["transaction"],
        properties: {
          transaction: { type: "string", description: "Signed challenge, base64 XDR" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            token: { type: "string" },
            user: {
              type: "object",
              properties: {
                id: { type: "string" },
                stellarAddress: { type: "string" },
                username: { type: "string", nullable: true },
              },
            },
          },
        },
      },
    },
    handler: controller.token,
  })
}
