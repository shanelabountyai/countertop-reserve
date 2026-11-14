-- Scorecard K5 (SEC-01): attempt counters for unauthenticated writes.
--
-- Fixed-window counters in Postgres, so a limit holds across every serverless
-- instance and survives a cold start (an in-memory counter does neither).
-- One atomic upsert per hit (packages/db/rate-limit.ts). Keys carry a hash of
-- the client address, never the address itself. Rows whose window ended over a
-- day ago are deleted by the cron sweep.

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key","windowStart")
);
