import { Prisma } from "@prisma/client"

export const ZERO_SEED = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSU2"

export const TEST_ENV = {
  NODE_ENV: "test",
  PORT: "3000",
  DATABASE_URL: "postgresql://user:password@localhost:5432/rubbi",
  REDIS_URL: "redis://localhost:6379",
  STELLAR_NETWORK: "testnet",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  USDC_SAC_ID: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  VAULT_CONTRACT_ID: "CBGARSQ7BY4345DNX76LWT4VXEHRRFJMNW46SCX7DRHBILL5V6RJN6KR",
  SUBSCRIPTIONS_CONTRACT_ID: "CDWMLKAUMXHLSBOKKCK5A4ECUP2VIIHXAL7MVQ5TEFLE3QUXZRMDC3PC",
  PAYROLL_CONTRACT_ID: "CB76PQ2MTILAQJAHLMTRHYDODX7H73YUCTVVKYO46ME3MK6WUTELDGYU",
  OPERATOR_SECRET: ZERO_SEED,
  KEEPER_SECRET: ZERO_SEED,
  SEP10_SIGNING_SECRET: ZERO_SEED,
  TREASURY_SECRET: "",
  HOME_DOMAIN: "localhost:3000",
  WEB_AUTH_DOMAIN: "localhost:3000",
  INDEXER_POLL_INTERVAL_MS: "5000",
  KEEPER_CRON: "*/10 * * * *",
  KEEPER_HOLD_SECONDS: "21600",
  CARD_ISSUER: "mock",
  SUDO_API_KEY: "",
  SUDO_BASE_URL: "https://api.sudo.africa",
  SUDO_DEFAULT_CUSTOMER_ID: "",
  SUDO_WEBHOOK_SECRET: "test-webhook-secret",
  JWT_SECRET: "test-jwt-secret-test-jwt-secret-1234",
  JWT_EXPIRES_IN: "24h",
  CORS_ORIGINS: "http://localhost:3000,https://app.rubbi.test",
} as const

export const USER_ADDRESS = "GCW4BXKRNKDICUSCI3RVP3MYTPQWMZ7ABCGAF5CZIWZ22U6TBIRDYE6G"
export const OTHER_ADDRESS = "GASCJCM7CLBWKKJ7UKXISRX67YRQD2EVL57YKPRCCTTECEZQYRJEPNXN"

export function seedEnv() {
  Object.assign(process.env, TEST_ENV)
}

export function makeHttpErrors() {
  const make = (statusCode: number) => (message: string) => {
    const err = new Error(message) as Error & { statusCode: number }
    err.statusCode = statusCode
    return err
  }
  return {
    badRequest: make(400),
    unauthorized: make(401),
    forbidden: make(403),
    notFound: make(404),
    conflict: make(409),
    unprocessableEntity: make(422),
    internalServerError: make(500),
    serviceUnavailable: make(503),
  }
}

export function makeRedis(setResponse: string | null = "OK") {
  return {
    get: async () => null,
    set: async () => setResponse,
    del: async () => 1,
    quit: async () => undefined,
  }
}

export function makeJwt() {
  return {
    sign: (payload: Record<string, unknown>) => `mock-token-${JSON.stringify(payload)}`,
  }
}

export function makeLog() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => makeLog(),
  }
}

export function makeTx(overrides?: Partial<{
  id: string
  userId: string
  type: string
  account: string
  amount: Prisma.Decimal
  balanceAfter: Prisma.Decimal
  description: string
  createdAt: Date
  metadata: Record<string, unknown>
}>) {
  return {
    id: overrides?.id ?? "txn-1",
    userId: overrides?.userId ?? "user-1",
    type: overrides?.type ?? "DEPOSIT",
    account: overrides?.account ?? "WALLET",
    amount: overrides?.amount ?? new Prisma.Decimal("10.00"),
    balanceAfter: overrides?.balanceAfter ?? new Prisma.Decimal("100.00"),
    description: overrides?.description ?? "Test transaction",
    metadata: overrides?.metadata ?? null,
    createdAt: overrides?.createdAt ?? new Date("2026-01-01"),
  }
}

export function makeCard(overrides?: Partial<{
  id: string
  userId: string
  issuerId: string
  issuer: string
  last4: string
  expiryMonth: string
  expiryYear: string
  status: string
}>) {
  return {
    id: overrides?.id ?? "card-1",
    userId: overrides?.userId ?? "user-1",
    issuerId: overrides?.issuerId ?? "issuer-card-1",
    issuer: overrides?.issuer ?? "MOCK",
    last4: overrides?.last4 ?? "1234",
    expiryMonth: overrides?.expiryMonth ?? "12",
    expiryYear: overrides?.expiryYear ?? "28",
    status: overrides?.status ?? "ACTIVE",
  }
}

export function makeUser(overrides?: Partial<{
  id: string
  stellarAddress: string
  username: string | null
  walletBalance: Prisma.Decimal
  cardBalance: Prisma.Decimal
  card: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}>) {
  return {
    id: overrides?.id ?? "user-1",
    stellarAddress: overrides?.stellarAddress ?? USER_ADDRESS,
    username: overrides?.username === undefined ? "testuser" : overrides.username,
    walletBalance: overrides?.walletBalance ?? new Prisma.Decimal("100.00"),
    cardBalance: overrides?.cardBalance ?? new Prisma.Decimal("25.00"),
    card: overrides?.card ?? null,
    createdAt: overrides?.createdAt ?? new Date("2026-01-01"),
    updatedAt: overrides?.updatedAt ?? new Date("2026-01-01"),
  }
}

export function makeDeposit(overrides?: Partial<{
  id: string
  userId: string
  txHash: string
  amountRaw: string
  amount: Prisma.Decimal
  status: string
  ledger: number
  confirmedAt: Date | null
  createdAt: Date
}>) {
  return {
    id: overrides?.id ?? "deposit-1",
    userId: overrides?.userId ?? "user-1",
    txHash: overrides?.txHash ?? "0".repeat(63) + "1",
    amountRaw: overrides?.amountRaw ?? "100000000",
    amount: overrides?.amount ?? new Prisma.Decimal("10.00"),
    status: overrides?.status ?? "CONFIRMED",
    ledger: overrides?.ledger ?? 5_420_000,
    confirmedAt: overrides?.confirmedAt === undefined ? new Date("2026-01-01") : overrides.confirmedAt,
    createdAt: overrides?.createdAt ?? new Date("2026-01-01"),
  }
}
