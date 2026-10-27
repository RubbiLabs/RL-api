import { PrismaClient } from "@prisma/client"

/**
 * Postgres-backed tests run only when TEST_DATABASE_URL points at a database
 * with the migrations applied (`bunx prisma migrate deploy`). Locally:
 * docker compose -f docker-compose.dev.yml up -d db, then
 * TEST_DATABASE_URL=postgresql://rubbi:rubbi@localhost:5432/rubbi_test.
 * CI sets it to its Postgres service container.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
export const hasTestDatabase = Boolean(TEST_DATABASE_URL)

export function makeTestPrisma() {
  return new PrismaClient({ datasourceUrl: TEST_DATABASE_URL })
}

/** Empties every table touched by the tests. */
export async function resetDatabase(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Transaction", "Deposit", "CardMovement", "Subscription", "SubscriptionPlan", ' +
      '"PayrollSchedule", "Card", "User", "ChainCursor", "ProcessedEvent", "ChainGap" CASCADE',
  )
}
