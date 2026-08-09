CREATE TABLE "staff_roadmap_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"apollo_last_import_at" timestamp with time zone,
	"apollo_last_import_count" integer
);
--> statement-breakpoint
ALTER TABLE "company_people" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "directory_suppressions" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
-- Hand-written below (drizzle cannot model CHECKs, partial indexes, or seed
-- rows; 0033/0034/0035/0038 precedent). company_id NULL = the XL.net staff
-- lane (§5.18 staff parity). The NULL lane needs its OWN partial uniques:
-- composite unique btrees treat NULL company_id rows as always-distinct
-- (NULLS DISTINCT default), so the 0035 indexes never dedupe staff rows.
-- staff_roadmap_state is one-row (CHECK id = 1) and SEEDED here: the stamp
-- write is an upsert, but an unseeded row must never leave the auto-kick
-- predicate permanently armed.
ALTER TABLE "staff_roadmap_state" ADD CONSTRAINT "staff_roadmap_state_one_row_ck" CHECK (id = 1);--> statement-breakpoint
INSERT INTO "staff_roadmap_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE UNIQUE INDEX "company_people_email_staff_uq" ON "company_people" (lower(email)) WHERE company_id IS NULL AND email IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "company_people_apollo_staff_uq" ON "company_people" ("apollo_id") WHERE company_id IS NULL AND apollo_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "directory_suppr_staff_uq" ON "directory_suppressions" ("email_sha256") WHERE company_id IS NULL;