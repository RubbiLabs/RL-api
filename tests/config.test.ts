import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Keypair } from "@stellar/stellar-sdk"
import { TEST_ENV, ZERO_SEED } from "./helpers.js"

const ENV_BACKUP = { ...process.env }
let counter = 0

function loadConfig() {
  counter++
  return import("../src/config/index.js?v=" + counter)
}

beforeEach(() => {
  Object.assign(process.env, TEST_ENV)
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key]
  }
  Object.assign(process.env, ENV_BACKUP)
})

describe("environment config validation", () => {
  test("accepts the example configuration", async () => {
    const { env } = await loadConfig()
    expect(env.STELLAR_NETWORK).toBe("testnet")
    expect(env.STELLAR_NETWORK_PASSPHRASE).toBe("Test SDF Network ; September 2015")
    expect(env.VAULT_CONTRACT_ID).toBe(TEST_ENV.VAULT_CONTRACT_ID)
    expect(env.CARD_ISSUER).toBe("mock")
    expect(env.TREASURY_SECRET).toBeUndefined()
    expect(env.INDEXER_START_LEDGER).toBeUndefined()
    expect(env.KEEPER_CRON).toBe("*/10 * * * *")
    expect(env.KEEPER_HOLD_SECONDS).toBe(21_600)
    expect(env.PORT).toBe(3000)
  })

  test("derives the passphrase from STELLAR_NETWORK when unset", async () => {
    process.env.STELLAR_NETWORK_PASSPHRASE = ""
    process.env.STELLAR_NETWORK = "mainnet"
    const { env } = await loadConfig()
    expect(env.STELLAR_NETWORK_PASSPHRASE).toBe("Public Global Stellar Network ; September 2015")
  })

  test("rejects a malformed Stellar secret", async () => {
    process.env.OPERATOR_SECRET = "SNOTASECRET"
    await expect(loadConfig()).rejects.toThrow("OPERATOR_SECRET: must be a Stellar secret seed")
  })

  test("rejects a public key where a secret is expected", async () => {
    process.env.KEEPER_SECRET = "GCW4BXKRNKDICUSCI3RVP3MYTPQWMZ7ABCGAF5CZIWZ22U6TBIRDYE6G"
    await expect(loadConfig()).rejects.toThrow("KEEPER_SECRET")
  })

  test("rejects a malformed contract id", async () => {
    process.env.PAYROLL_CONTRACT_ID = "0x0000000000000000000000000000000000000005"
    await expect(loadConfig()).rejects.toThrow("PAYROLL_CONTRACT_ID: must be a Soroban contract id")
  })

  test("rejects an account id where a contract id is expected", async () => {
    process.env.USDC_SAC_ID = "GCW4BXKRNKDICUSCI3RVP3MYTPQWMZ7ABCGAF5CZIWZ22U6TBIRDYE6G"
    await expect(loadConfig()).rejects.toThrow("USDC_SAC_ID")
  })

  test("rejects an invalid STELLAR_NETWORK", async () => {
    process.env.STELLAR_NETWORK = "futurenet"
    await expect(loadConfig()).rejects.toThrow("Invalid environment variables")
  })

  test("rejects a missing STELLAR_RPC_URL", async () => {
    delete process.env.STELLAR_RPC_URL
    await expect(loadConfig()).rejects.toThrow("STELLAR_RPC_URL")
  })

  test("accepts an optional TREASURY_SECRET when valid", async () => {
    process.env.TREASURY_SECRET = ZERO_SEED
    const { env } = await loadConfig()
    expect(env.TREASURY_SECRET).toBe(ZERO_SEED)
  })

  test("rejects a malformed TREASURY_SECRET", async () => {
    process.env.TREASURY_SECRET = "not-a-seed"
    await expect(loadConfig()).rejects.toThrow("TREASURY_SECRET")
  })

  test("SUDO_* are optional under CARD_ISSUER=mock and a dev webhook secret is used", async () => {
    process.env.SUDO_API_KEY = ""
    process.env.SUDO_WEBHOOK_SECRET = ""
    const { env } = await loadConfig()
    expect(env.SUDO_API_KEY).toBeUndefined()
    expect(env.SUDO_WEBHOOK_SECRET).toBe("mock-card-issuer-webhook-secret")
  })

  test("SUDO_API_KEY and SUDO_WEBHOOK_SECRET are required under CARD_ISSUER=sudo", async () => {
    process.env.CARD_ISSUER = "sudo"
    process.env.SUDO_API_KEY = ""
    process.env.SUDO_WEBHOOK_SECRET = ""
    await expect(loadConfig()).rejects.toThrow("SUDO_API_KEY is required when CARD_ISSUER=sudo")
  })

  test("rejects the placeholder signing secret in production", async () => {
    process.env.NODE_ENV = "production"
    process.env.JWT_SECRET = "a-real-looking-secret-with-32-characters!"
    await expect(loadConfig()).rejects.toThrow(
      "OPERATOR_SECRET cannot be the all-zero placeholder in production",
    )
  })

  test("rejects the example JWT secret in production", async () => {
    process.env.NODE_ENV = "production"
    // Real-looking (random, throwaway) seeds so only the JWT placeholder is at fault.
    process.env.OPERATOR_SECRET = Keypair.random().secret()
    process.env.KEEPER_SECRET = Keypair.random().secret()
    process.env.SEP10_SIGNING_SECRET = Keypair.random().secret()
    process.env.JWT_SECRET = "replace-with-at-least-32-char-secret"
    await expect(loadConfig()).rejects.toThrow("JWT_SECRET cannot be the example placeholder")
  })

  test("rejects a short JWT_SECRET", async () => {
    process.env.JWT_SECRET = "short"
    await expect(loadConfig()).rejects.toThrow("Invalid environment variables")
  })

  test("rejects an invalid CARD_ISSUER", async () => {
    process.env.CARD_ISSUER = "visa"
    await expect(loadConfig()).rejects.toThrow("CARD_ISSUER")
  })

  test("parses CORS_ORIGINS into exact origins and defaults to localhost:3000", async () => {
    process.env.CORS_ORIGINS = " http://localhost:3001/ , https://app.rubbi.test/some/path,http://localhost:3001"
    const { env } = await loadConfig()
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:3001", "https://app.rubbi.test"])

    delete process.env.CORS_ORIGINS
    const { env: defaults } = await loadConfig()
    expect(defaults.CORS_ORIGINS).toEqual(["http://localhost:3000"])
  })

  test("rejects CORS_ORIGINS entries that are not http(s) URLs or wildcards", async () => {
    process.env.CORS_ORIGINS = "http://localhost:3000,*"
    await expect(loadConfig()).rejects.toThrow('CORS_ORIGINS: "*" is not a valid URL')

    process.env.CORS_ORIGINS = "ftp://files.rubbi.test"
    await expect(loadConfig()).rejects.toThrow("CORS_ORIGINS")

    process.env.CORS_ORIGINS = " , "
    await expect(loadConfig()).rejects.toThrow("CORS_ORIGINS: at least one origin is required")
  })
})
