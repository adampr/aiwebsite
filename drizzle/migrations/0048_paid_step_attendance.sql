-- Admin-attested attendance for the two paid roadmap steps (§5.18, owner ask
-- 2026-08-20): how many employees have attended the workshop and the cohort,
-- per company AND for the XL.net staff lane (staff_roadmap_state is the
-- one-row staff analogue of the companies row; xl.net is never a companies
-- row by hard invariant). Purchases are server-invisible, so these are
-- numbers a global admin types on /admin/roadmap, never computed; they are
-- informational only (paid runway nodes stay "offered" by ruling).
-- IF NOT EXISTS guards are the 0044/0046 precedent: a hand-applied catch-up
-- on the VM must not fail the deploy migration. CHECKs are migration-only
-- (drizzle cannot model them; 0035/0041 precedent) and wrapped in DO $$
-- because ADD CONSTRAINT has no IF NOT EXISTS (0047 precedent).
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "workshop_attended" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "cohort_attended" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_roadmap_state" ADD COLUMN IF NOT EXISTS "workshop_attended" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_roadmap_state" ADD COLUMN IF NOT EXISTS "cohort_attended" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "companies" ADD CONSTRAINT "companies_workshop_attended_ck" CHECK (workshop_attended >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "companies" ADD CONSTRAINT "companies_cohort_attended_ck" CHECK (cohort_attended >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "staff_roadmap_state" ADD CONSTRAINT "staff_roadmap_state_workshop_attended_ck" CHECK (workshop_attended >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "staff_roadmap_state" ADD CONSTRAINT "staff_roadmap_state_cohort_attended_ck" CHECK (cohort_attended >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
