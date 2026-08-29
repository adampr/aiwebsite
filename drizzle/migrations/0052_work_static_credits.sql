-- WHO BUILT EACH HAND-WRITTEN /work EXHIBIT (owner ruling 2026-08-29).
-- The 26 exhibits on the public Our Work page are page copy, not
-- work_submissions rows, so the people who built them were counted by
-- nothing on the §5.18 Employee Scorecard and two of them read "0 published"
-- while the company publicly showcased their tool.
--
-- THIS MIGRATION CREATES AN EMPTY TABLE AND MUST STAY THAT WAY. The rows map
-- a colleague's email address to an exhibit, and THIS REPOSITORY IS PUBLIC:
-- a seed INSERT here, in a fixture, or in a checked-in map would publish
-- those addresses to the open internet permanently, and git history keeps
-- them after any revert. The rows are written on the production VM. Same
-- ruling as 0051_chase_register, taken the same day for the same reason.
--
-- NUMBERED 0052, and there is deliberately no 0050. This work was in flight
-- as 0050 when a concurrent session generated 0051 against a schema that
-- already contained this table, so 0051's snapshot carries it while 0051's
-- SQL does not create it. Rather than leave a migration whose snapshot and
-- statements disagree, 0050 was withdrawn and the CREATE moved here, after
-- 0051. Several sessions share this checkout: re-read
-- drizzle/migrations/meta/_journal.json immediately before generating.
--
-- IF NOT EXISTS throughout (0044/0046/0047/0048/0049/0051 precedent): a
-- hand-applied catch-up on the VM must be able to run this file again
-- without failing the deploy's db:migrate step.
CREATE TABLE IF NOT EXISTS "work_static_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anchor_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_email" text NOT NULL
);--> statement-breakpoint

-- ── HAND-ADDED BELOW (0039/0051 precedent) ──────────────────────────────
-- One credit per (exhibit, person): an exhibit can have two builders, so the
-- PAIR is what must be unique, and a PRIMARY KEY on anchor_id alone would
-- make a second builder silently overwrite the first.
--
-- lower(email) is LOAD-BEARING, not cosmetic, and this is the 0039
-- company_people_email_staff_uq form. Every read groups on lower(email), so
-- a raw-column index would accept an address typed with a capital letter
-- beside the same address in lower case, while the reader collapsed the two
-- onto one key: that person's Exhibits cell would
-- read 2 for a single exhibit, on the page whose entire purpose is being
-- accurate about who built what. Expression indexes are invisible to
-- drizzle-kit, which is why this is hand-added and why deploys must keep
-- using `drizzle-kit migrate` and never `push`.
CREATE UNIQUE INDEX IF NOT EXISTS "work_static_credit_uq" ON "work_static_credits" ("anchor_id", lower("email"));
