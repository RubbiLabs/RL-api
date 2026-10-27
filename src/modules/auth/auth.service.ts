import { Keypair, WebAuth } from "@stellar/stellar-sdk"
import { FastifyInstance } from "fastify"

import { env } from "../../config/index.js"

/** Seconds a challenge stays valid. SEP-10 recommends 5 to 15 minutes. */
export const CHALLENGE_TIMEOUT_SECONDS = 300

let serverKeypair: Keypair | null = null

/** The SEP-10 server signing key. Derived once from SEP10_SIGNING_SECRET. */
export function getServerKeypair(): Keypair {
  if (!serverKeypair) {
    serverKeypair = Keypair.fromSecret(env.SEP10_SIGNING_SECRET)
  }
  return serverKeypair
}

/**
 * SEP-10 step 1: build a challenge transaction for `account`.
 *
 * The transaction has sequence number 0 (it can never be submitted), is
 * signed by the server, carries the home domain in a manage-data operation
 * and expires after CHALLENGE_TIMEOUT_SECONDS.
 */
export function buildChallenge(account: string) {
  const transaction = WebAuth.buildChallengeTx(
    getServerKeypair(),
    account,
    env.HOME_DOMAIN,
    CHALLENGE_TIMEOUT_SECONDS,
    env.STELLAR_NETWORK_PASSPHRASE,
    env.WEB_AUTH_DOMAIN,
  )

  return {
    transaction,
    network_passphrase: env.STELLAR_NETWORK_PASSPHRASE,
  }
}

/**
 * SEP-10 step 2: verify a challenge the client signed and issue a JWT.
 *
 * Checks, in the SDK's `readChallengeTx` / `verifyChallengeTxSigners`:
 * the server signature, sequence number 0, time bounds, home domain, web
 * auth domain, and that the client account's master key signed.
 *
 * Only the master key is accepted. Accounts whose master key weight is zero
 * or that use multisig need a Horizon signer lookup
 * (`verifyChallengeTxThreshold`); contract accounts need SEP-45. Both are
 * backlog items.
 */
export async function verifyChallengeAndIssueToken(
  app: FastifyInstance,
  transaction: string,
) {
  const serverPublicKey = getServerKeypair().publicKey()
  let clientAccountId: string

  try {
    const details = WebAuth.readChallengeTx(
      transaction,
      serverPublicKey,
      env.STELLAR_NETWORK_PASSPHRASE,
      env.HOME_DOMAIN,
      env.WEB_AUTH_DOMAIN,
    )
    clientAccountId = details.clientAccountID

    WebAuth.verifyChallengeTxSigners(
      transaction,
      serverPublicKey,
      env.STELLAR_NETWORK_PASSPHRASE,
      [clientAccountId],
      env.HOME_DOMAIN,
      env.WEB_AUTH_DOMAIN,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid challenge"
    throw app.httpErrors.unauthorized(`SEP-10 challenge rejected: ${message}`)
  }

  const user = await app.prisma.user.upsert({
    where: { stellarAddress: clientAccountId },
    update: {},
    create: { stellarAddress: clientAccountId },
    select: { id: true, stellarAddress: true, username: true },
  })

  const token = app.jwt.sign({ sub: user.stellarAddress })

  return {
    token,
    user: {
      id: user.id,
      stellarAddress: user.stellarAddress,
      username: user.username,
    },
  }
}
