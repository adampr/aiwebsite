-- "Time saved per month for you" on a work submission (§5.16/§5.18, owner ask
-- 2026-08-27): the submitter's OWN estimate of the time this work saves them
-- in a month, self-reported and never panel-verified, which is why every
-- surface that prints it attributes it to the submitter.
-- NULLABLE with no default and no backfill: NULL means "not reported", which
-- is the honest state of every existing row and of every row that arrives by
-- email intake. Entering 0 hours in the form clears the value back to NULL,
-- so there is exactly one representation of "nothing reported".
-- Stored in whole MINUTES while every input asks for HOURS (people think in
-- hours a month): minutes keep "6 hours 30 minutes" exact with no float ever
-- reaching the column.
-- IF NOT EXISTS is the 0044/0046/0048 precedent: a hand-applied catch-up on
-- the VM must not fail the deploy migration.
-- The range CHECK is migration-only (drizzle cannot model CHECKs; 0034/0035
-- precedent), so `drizzle-kit push` would silently drop it and deploys must
-- keep using `drizzle-kit migrate`. 44640 minutes is 744 hours, every hour of
-- a 31-day month: the physical ceiling on time saved WITHIN a month. The lower
-- bound is 1, not 0, because a stored zero would be a second spelling of
-- "not reported" that no reader could tell from a real report of no saving.
-- Wrapped in DO $$ because ADD CONSTRAINT has no IF NOT EXISTS (0047/0048
-- precedent).
ALTER TABLE "work_submissions" ADD COLUMN IF NOT EXISTS "time_saved_minutes" integer;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_submissions" ADD CONSTRAINT "work_submissions_time_saved_ck" CHECK (time_saved_minutes IS NULL OR (time_saved_minutes >= 1 AND time_saved_minutes <= 44640));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
