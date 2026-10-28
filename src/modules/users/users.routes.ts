import { FastifyInstance } from "fastify"

import { buildUsersController } from "./users.controller.js"

const userResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    stellarAddress: { type: "string" },
    username: { type: "string", nullable: true },
    walletBalance: { type: "string", description: "USDC in the user's vault (mirror)" },
    cardBalance: { type: "string", description: "USDC loaded on the card" },
    card: {
      nullable: true,
      type: "object",
      properties: {
        id: { type: "string" },
        issuer: { type: "string", description: "MOCK or SUDO" },
        issuerId: { type: "string" },
        last4: { type: "string" },
        expiryMonth: { type: "string" },
        expiryYear: { type: "string" },
        status: { type: "string" },
      },
    },
  },
} as const

const errorResponse = {
  type: "object",
  properties: {
    statusCode: { type: "number" },
    error: { type: "string" },
    message: { type: "string" },
  },
} as const

export async function registerUsersRoutes(app: FastifyInstance) {
  const controller = buildUsersController(app)

  app.get("/users/me", {
    onRequest: app.authenticate,
    schema: {
      tags: ["users"],
      description: "Current user profile, balances and card",
      response: { 200: userResponse, 404: errorResponse },
    },
    handler: controller.me,
  })

  app.post("/users/username", {
    onRequest: app.authenticate,
    schema: {
      tags: ["users"],
      description:
        "Set the username once (3-32 chars, [a-z0-9_]). One username per Stellar address. " +
        "Creates the user's card on first call.",
      body: {
        type: "object",
        required: ["username"],
        properties: {
          username: { type: "string", minLength: 3, maxLength: 32, pattern: "^[a-z0-9_]+$" },
        },
      },
      response: { 200: userResponse, 404: errorResponse, 409: errorResponse },
    },
    handler: controller.username,
  })
}
