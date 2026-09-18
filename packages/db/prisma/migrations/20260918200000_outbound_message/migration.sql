-- AlterTable (hand-edited: nullable, backfilled, then NOT NULL, so a
-- database that already holds reservations can apply it)
ALTER TABLE "Reservation" ADD COLUMN     "manageToken" TEXT;
-- Two v4 UUIDs = 244 random bits, above the 128-bit floor. New rows get
-- 128 bits of crypto.randomBytes from placement.
UPDATE "Reservation" SET "manageToken" = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
ALTER TABLE "Reservation" ALTER COLUMN "manageToken" SET NOT NULL;

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_providerMessageId_key" ON "OutboundMessage"("providerMessageId");

-- CreateIndex
CREATE INDEX "OutboundMessage_status_createdAt_idx" ON "OutboundMessage"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_reservationId_kind_key" ON "OutboundMessage"("reservationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_manageToken_key" ON "Reservation"("manageToken");

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══ HAND-WRITTEN ═══════════════════════════════════════════════════════════

-- V-006 (P0-5). The lists mirror MESSAGE_KINDS and DELIVERY_STATUSES in
-- packages/core/messages.ts. A "sent" row with no provider id, or a "failed"
-- row with no reason, is a delivery record nobody can reconcile.
ALTER TABLE "OutboundMessage"
  ADD CONSTRAINT outbound_kind_known CHECK ("kind" IN ('confirmation')),
  ADD CONSTRAINT outbound_status_known CHECK ("status" IN ('queued', 'sent', 'delivered', 'failed')),
  ADD CONSTRAINT outbound_body_max_320 CHECK (char_length("body") <= 320),
  ADD CONSTRAINT outbound_sent_has_provider_id CHECK ("status" NOT IN ('sent', 'delivered') OR "providerMessageId" IS NOT NULL),
  ADD CONSTRAINT outbound_failed_has_reason CHECK ("status" <> 'failed' OR "failureReason" IS NOT NULL);
