import { Networks, StrKey } from "@stellar/stellar-sdk"
import { z } from "zod"

/**
 * The all-zero ed25519 seed. It is a syntactically valid secret, so local
 * development works out of the box, but it is rejected in production.
 */
export const PLACEHOLDER_SECRET = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSU2"

/** Used to sign webhook payloads when CARD_ISSUER=mock and no secret is set. */
export const MOCK_WEBHOOK_SECRET = "mock-card-issuer-webhook-secret"

const stellarSecret = z
  .string()
  .refine((value) => StrKey.isValidEd25519SecretSeed(value), {
    message: "must be a Stellar secret seed (S..., 56 characters)",
  })

/** Treats an empty string (what dotenv yields for `KEY=`) as unset. */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value

const optionalString = () => z.preprocess(blankToUndefined, z.string().min(1).optional())

/**
 * Comma-separated list of browser origins allowed by CORS. Each entry must be
 * an absolute URL; only its origin (scheme, host, port) is kept. No wildcard.
 */
const corsOrigins = z
  .string()
  .default("http://localhost:3001")
  .transform((value, ctx) => {
    const origins: string[] = []
    for (const raw of value.split(",")) {
      const entry = raw.trim()
      if (!entry) continue
      let url: URL
      try {
        url = new URL(entry)
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${entry}" is not a valid URL` })
        return z.NEVER
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${entry}" must be an http(s) URL` })
        return z.NEVER
      }
      if (!origins.includes(url.origin)) origins.push(url.origin)
    }
    if (origins.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "at least one origin is required" })
      return z.NEVER
    }
    return origins
  })

const contractId = z
  .string()
  .refine((value) => StrKey.isValidContract(value), {
    message: "must be a Soroban contract id (C..., 56 characters)",
  })

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
    STELLAR_RPC_URL: z.string().url(),
    // Defaults to the passphrase of STELLAR_NETWORK when empty (see below).
    STELLAR_NETWORK_PASSPHRASE: optionalString(),

    USDC_SAC_ID: contractId,
    VAULT_CONTRACT_ID: contractId,
    SUBSCRIPTIONS_CONTRACT_ID: contractId,
    PAYROLL_CONTRACT_ID: contractId,

    // Backend signing keys. Public keys are derived; secrets never leave the process.
    OPERATOR_SECRET: stellarSecret,
    KEEPER_SECRET: stellarSecret,
    SEP10_SIGNING_SECRET: stellarSecret,
    // Optional: when unset, card unloads wait in PENDING_TREASURY for manual processing.
    TREASURY_SECRET: z.preprocess(blankToUndefined, stellarSecret.optional()),

    HOME_DOMAIN: z.string().min(1),
    WEB_AUTH_DOMAIN: z.string().min(1),

    INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
    // Ledger to start from on the very first run. Defaults to the latest ledger.
    INDEXER_START_LEDGER: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    KEEPER_CRON: z.string().min(1).default("*/10 * * * *"),
    // How long a payee without a usable USDC trustline is left alone by the keeper.
    KEEPER_HOLD_SECONDS: z.coerce.number().int().min(60).default(21_600),

    CARD_ISSUER: z.enum(["mock", "sudo"]).default("mock"),
    SUDO_API_KEY: optionalString(),
    SUDO_BASE_URL: z.string().url().default("https://api.sudo.africa"),
    SUDO_DEFAULT_CUSTOMER_ID: optionalString(),
    SUDO_WEBHOOK_SECRET: optionalString(),

    JWT_SECRET: z.string().min(32),
    JWT_EXPIRES_IN: z.string().default("24h"),

    // Browser origins allowed to call the API (the frontend). Exact origins only.
    CORS_ORIGINS: corsOrigins,
  })
  .superRefine((value, ctx) => {
    if (value.CARD_ISSUER === "sudo") {
      for (const key of ["SUDO_API_KEY", "SUDO_WEBHOOK_SECRET"] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when CARD_ISSUER=sudo`,
          })
        }
      }
    }

    if (value.NODE_ENV !== "production") {
      return
    }

    for (const key of [
      "OPERATOR_SECRET",
      "KEEPER_SECRET",
      "SEP10_SIGNING_SECRET",
      "TREASURY_SECRET",
    ] as const) {
      if (value[key] === PLACEHOLDER_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} cannot be the all-zero placeholder in production`,
        })
      }
    }

    if (/replace-with/i.test(value.JWT_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_SECRET"],
        message: "JWT_SECRET cannot be the example placeholder in production",
      })
    }

    if (!value.SUDO_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUDO_WEBHOOK_SECRET"],
        message: "SUDO_WEBHOOK_SECRET must be set explicitly in production",
      })
    }
  })
  .transform((value) => ({
    ...value,
    STELLAR_NETWORK_PASSPHRASE:
      value.STELLAR_NETWORK_PASSPHRASE ??
      (value.STELLAR_NETWORK === "mainnet"
        ? Networks.PUBLIC
        : Networks.TESTNET),
    SUDO_WEBHOOK_SECRET: value.SUDO_WEBHOOK_SECRET ?? MOCK_WEBHOOK_SECRET,
  }))

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("\n")

  throw new Error(`Invalid environment variables:\n${details}`)
}

export const env = parsed.data
export type Env = typeof env
