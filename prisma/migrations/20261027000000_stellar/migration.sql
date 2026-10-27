-- Stellar migration (replaces the Arbitrum data model).
--
-- Legacy rows cannot be carried over: wallet addresses were EVM addresses,
-- balances were RUBBI token amounts and subscriptions pointed at EVM plan
-- indexes. The new NOT NULL columns (User.stellarAddress, Transaction.account,
-- ...) have no meaningful value for those rows, so the tables are emptied
-- first. Nothing in this migration touches a Stellar deployment's data.
TRUNCATE TABLE "Transaction", "Deposit", "Subscription", "Card", "User" CASCADE;

-- CreateEnum
CREATE TYPE "BalanceAccount" AS ENUM ('WALLET', 'CARD');

-- CreateEnum
CREATE TYPE "CardMoveDirection" AS ENUM ('LOAD', 'UNLOAD');

-- CreateEnum
CREATE TYPE "CardMoveStatus" AS ENUM ('PENDING', 'SETTLED', 'PENDING_TREASURY', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "SubStatus" ADD VALUE 'PAST_DUE';

-- AlterEnum
BEGIN;
CREATE TYPE "TransactionType_new" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'CARD_LOAD', 'CARD_UNLOAD', 'CARD_SPEND_SETTLED', 'SPEND', 'REFUND', 'SUBSCRIPTION_PAYMENT', 'PAYROLL_FUNDED', 'PAYROLL_DISBURSED');
ALTER TABLE "Transaction" ALTER COLUMN "type" TYPE "TransactionType_new" USING ("type"::text::"TransactionType_new");
ALTER TYPE "TransactionType" RENAME TO "TransactionType_old";
ALTER TYPE "TransactionType_new" RENAME TO "TransactionType";
DROP TYPE "public"."TransactionType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_userId_fkey";

-- DropIndex
DROP INDEX "Deposit_txHash_key";

-- DropIndex
DROP INDEX "Subscription_userId_onChainPlanId_idx";

-- DropIndex
DROP INDEX "User_walletAddress_key";

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "issuer" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Deposit" DROP COLUMN "amountRubbi",
DROP COLUMN "blockNumber",
ADD COLUMN     "amount" DECIMAL(20,7) NOT NULL,
ADD COLUMN     "eventId" TEXT NOT NULL,
ADD COLUMN     "ledger" INTEGER NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'CONFIRMED';

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "feeRubbi",
DROP COLUMN "onChainPlanId",
DROP COLUMN "planName",
ADD COLUMN     "lastChargedAt" TIMESTAMP(3),
ADD COLUMN     "nextDueAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "onChainSubId" BIGINT NOT NULL,
ADD COLUMN     "planId" INTEGER NOT NULL,
ADD COLUMN     "subscriber" TEXT NOT NULL,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "amountRubbi",
ADD COLUMN     "account" "BalanceAccount" NOT NULL,
ADD COLUMN     "amount" DECIMAL(20,7) NOT NULL,
ALTER COLUMN "balanceAfter" SET DATA TYPE DECIMAL(20,7);

-- AlterTable
ALTER TABLE "User" DROP COLUMN "rubbiBalance",
DROP COLUMN "walletAddress",
ADD COLUMN     "cardBalance" DECIMAL(20,7) NOT NULL DEFAULT 0,
ADD COLUMN     "stellarAddress" TEXT NOT NULL,
ADD COLUMN     "walletBalance" DECIMAL(20,7) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CardMovement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "CardMoveDirection" NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "CardMoveStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CardMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" INTEGER NOT NULL,
    "merchant" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "period" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollSchedule" (
    "id" TEXT NOT NULL,
    "onChainId" BIGINT NOT NULL,
    "employer" TEXT NOT NULL,
    "employerUserId" TEXT,
    "recipient" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "period" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "lastDisbursedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainCursor" (
    "id" TEXT NOT NULL,
    "cursor" TEXT NOT NULL,
    "lastLedger" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "eventId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateTable
CREATE TABLE "ChainGap" (
    "id" TEXT NOT NULL,
    "fromLedger" INTEGER NOT NULL,
    "toLedger" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ChainGap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardMovement_reference_key" ON "CardMovement"("reference");

-- CreateIndex
CREATE INDEX "CardMovement_userId_createdAt_idx" ON "CardMovement"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CardMovement_status_idx" ON "CardMovement"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollSchedule_onChainId_key" ON "PayrollSchedule"("onChainId");

-- CreateIndex
CREATE INDEX "PayrollSchedule_employer_idx" ON "PayrollSchedule"("employer");

-- CreateIndex
CREATE INDEX "PayrollSchedule_recipient_idx" ON "PayrollSchedule"("recipient");

-- CreateIndex
CREATE INDEX "PayrollSchedule_status_nextDueAt_idx" ON "PayrollSchedule"("status", "nextDueAt");

-- CreateIndex
CREATE INDEX "ProcessedEvent_contractId_ledger_idx" ON "ProcessedEvent"("contractId", "ledger");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_eventId_key" ON "Deposit"("eventId");

-- CreateIndex
CREATE INDEX "Deposit_txHash_idx" ON "Deposit"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_onChainSubId_key" ON "Subscription"("onChainSubId");

-- CreateIndex
CREATE INDEX "Subscription_subscriber_idx" ON "Subscription"("subscriber");

-- CreateIndex
CREATE INDEX "Subscription_status_nextDueAt_idx" ON "Subscription"("status", "nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_stellarAddress_key" ON "User"("stellarAddress");

-- AddForeignKey
ALTER TABLE "CardMovement" ADD CONSTRAINT "CardMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollSchedule" ADD CONSTRAINT "PayrollSchedule_employerUserId_fkey" FOREIGN KEY ("employerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

