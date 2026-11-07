import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { TransactionBuilder, WebAuth } from "@stellar/stellar-sdk"

import { env } from "../../config/index.js"
import { getAccountRateLimitStore } from "../../lib/rate-limit/account-limiter.js"
import { challengeQuerySchema, tokenBodySchema } from "./auth.schema.js"
import { buildChallenge, getServerKeypair, verifyChallengeAndIssueToken } from "./auth.service.js"

export function buildAuthController(app: FastifyInstance) {
  return {
    challenge: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = challengeQuerySchema.safeParse(request.query)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid account")
      }

      const store = getAccountRateLimitStore(app)
      const key = `auth:rate:challenge:${parsed.data.account}`
      const { count, ttl } = await store.incr(key, 60)

      if (count > env.AUTH_CHALLENGE_LIMIT_PER_ACCOUNT) {
        reply.header("Retry-After", String(ttl))
        return reply.status(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: `Rate limit exceeded, retry in ${ttl} seconds`,
        })
      }

      return reply.send(buildChallenge(parsed.data.account))
    },

    token: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = tokenBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw app.httpErrors.badRequest(parsed.error.issues[0]?.message ?? "invalid body")
      }

      // Parse transaction early to extract client account; reject malformed XDR early with 400
      let clientAccountId: string
      try {
        const tx = TransactionBuilder.fromXDR(parsed.data.transaction, env.STELLAR_NETWORK_PASSPHRASE)
        const firstOp = tx.operations[0]
        if (firstOp && "source" in firstOp && firstOp.source) {
          clientAccountId = firstOp.source
        } else {
          const details = WebAuth.readChallengeTx(
            parsed.data.transaction,
            getServerKeypair().publicKey(),
            env.STELLAR_NETWORK_PASSPHRASE,
            env.HOME_DOMAIN,
            env.WEB_AUTH_DOMAIN,
          )
          clientAccountId = details.clientAccountID
        }
      } catch {
        throw app.httpErrors.badRequest("Malformed transaction XDR")
      }

      const store = getAccountRateLimitStore(app)
      const key = `auth:rate:token:${clientAccountId}`
      const { count, ttl } = await store.incr(key, 60)

      if (count > env.AUTH_TOKEN_LIMIT_PER_ACCOUNT) {
        reply.header("Retry-After", String(ttl))
        return reply.status(429).send({
          statusCode: 429,
          error: "Too Many Requests",
          message: `Rate limit exceeded, retry in ${ttl} seconds`,
        })
      }

      try {
        const result = await verifyChallengeAndIssueToken(app, parsed.data.transaction)
        return reply.send(result)
      } catch (error) {
        const statusCode = (error as any)?.statusCode ?? (error as any)?.status
        if (statusCode === 401) {
          // 401 failures count double so repeated bad signatures back off faster
          await store.incr(key, 60)
        }
        throw error
      }
    },
  }
}
