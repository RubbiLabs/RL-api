-- CreateTable
CREATE TABLE "DeadLetterEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lastError" TEXT NOT NULL,
    "firstFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reprocessedAt" TIMESTAMP(3),

    CONSTRAINT "DeadLetterEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeadLetterEvent_eventId_key" ON "DeadLetterEvent"("eventId");

-- CreateIndex
CREATE INDEX "DeadLetterEvent_contractId_ledger_idx" ON "DeadLetterEvent"("contractId", "ledger");

-- CreateIndex
CREATE INDEX "DeadLetterEvent_reprocessedAt_idx" ON "DeadLetterEvent"("reprocessedAt");
