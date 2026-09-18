-- V-009 (P0-8): the consent wording the guest agreed to, stored verbatim.
-- Nullable: host-entered bookings and walk-ins carry no consent, and get no
-- reservation-owned texts. Blank is not consent.
ALTER TABLE "Reservation" ADD COLUMN "smsConsent" TEXT;
ALTER TABLE "Reservation" ADD CONSTRAINT reservation_sms_consent_not_blank CHECK (btrim("smsConsent") <> '');
