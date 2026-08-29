-- CHASE REGISTER (§5.21, owner ask 2026-08-29: "For any work by others, I
-- recommend Tron emails them every week day until they have completed your
-- requested task. Report to me weekly if anyone is left that has not done
-- what you asked.")
--
-- THIS MIGRATION CREATES TWO EMPTY TABLES AND MUST STAY THAT WAY. Every row
-- names a colleague by address and records whether they have done what they
-- were asked, and THIS REPOSITORY IS PUBLIC: a seed INSERT here, in a
-- fixture, or in a checked-in map would publish a machine-readable
-- delinquency list of real people to the open internet permanently, and git
-- history keeps it after any revert. Same ruling as 0052_work_static_credits,
-- taken the same day for the same reason. Rows are written on the production
-- VM by `npm run chase:seed`, which reads the people from a run-time file
-- path or stdin and refuses any address not already in the staff directory.
--
-- NUMBERED 0054, AND THE NUMBER IS LOAD-BEARING. This was first written as
-- 0051 while four sessions shared this checkout, then briefly 0053, and both
-- numbers were wrong for the same reason: drizzle applies migrations in
-- journal order and the TAIL snapshot must describe everything already
-- committed. A file numbered BELOW a committed migration is skipped silently
-- on a database that has already run the higher one, which exits 0 and leaves
-- the deploy with no chase_* tables; and a snapshot generated below the tail
-- makes the next db:generate re-emit CREATE TABLE for tables that exist.
-- 0052_work_static_credits and 0053_work_cleaning landed while this round was
-- in refutation, so this file sits above both, and meta/0054_snapshot.json was
-- regenerated against 0053's so the chain is honest (verified: 0054.prevId
-- equals 0053.id, and the snapshot carries both the chase tables and 0053's
-- cleaning_json column).
--
-- The STATEMENTS below are hand-written and the SNAPSHOT beside them is
-- generated, which is the only combination that leaves both halves honest:
-- drizzle-kit models neither CHECK constraints nor partial and expression
-- indexes, so shipping its generated body would silently drop the
-- double-send guarantee, the anti-reseed rail and every status invariant.
--
-- IF NOT EXISTS throughout and every ADD CONSTRAINT wrapped in
-- DO $$ ... EXCEPTION WHEN duplicate_object (0044/0046/0047/0048/0049
-- precedent): a hand-applied catch-up on the VM must be able to run this
-- file again without failing the deploy's db:migrate step.
--
-- The CHECKs and the two partial indexes below are HAND-ADDED and invisible
-- to drizzle-kit, which models neither: `drizzle-kit push` would silently
-- drop them, so deploys must keep using `drizzle-kit migrate`.
CREATE TABLE IF NOT EXISTS "chase_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"send_date" date NOT NULL,
	"assignee_email" text NOT NULL,
	"kind" text DEFAULT 'nudge' NOT NULL,
	"task_ids_json" text NOT NULL,
	"task_count" integer NOT NULL,
	"subject" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"outcome" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chase_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignee_email" text NOT NULL,
	"assignee_name" text NOT NULL,
	"assignee_person_id" uuid,
	"requester_email" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"action_url" text,
	"status" text DEFAULT 'blocked' NOT NULL,
	"blocked_reason" text,
	"paused_reason" text,
	"opened_at" timestamp with time zone,
	"detector" text DEFAULT 'manual' NOT NULL,
	"detector_arg" text,
	"detector_md_sha256" text,
	"marked_done_at" timestamp with time zone,
	"marked_done_by" text,
	"marked_done_note" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"close_evidence_json" text,
	"declined_reason" text,
	"nudge_count" integer DEFAULT 0 NOT NULL,
	"first_nudged_on" date,
	"last_nudged_on" date,
	"last_accepted_send_at" timestamp with time zone,
	"consecutive_send_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "chase_tasks" ADD CONSTRAINT "chase_tasks_assignee_person_id_company_people_id_fk" FOREIGN KEY ("assignee_person_id") REFERENCES "public"."company_people"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chase_send_date_idx" ON "chase_sends" USING btree ("send_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chase_task_status_idx" ON "chase_tasks" USING btree ("status","last_nudged_on");--> statement-breakpoint

-- ── HAND-ADDED BELOW (0038/0047/0048/0049 precedent) ────────────────────

-- THE DOUBLE-SEND GUARANTEE. One email per (UTC day, recipient, kind), and
-- it is an index rather than a code path on purpose: the ledger row is
-- INSERTed BEFORE the send, so no interleaving of a timer fire, a hand run,
-- a reboot catch-up, a redeploy or two overlapping passes can produce two
-- nudges to one person in one day. The lower() keeps a mixed-case write from
-- being a second spelling of the same recipient.
CREATE UNIQUE INDEX IF NOT EXISTS "chase_send_day_uq" ON "chase_sends" (send_date, lower(assignee_email), kind);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "chase_sends" ADD CONSTRAINT "chase_send_kind_ck" CHECK (kind IN ('nudge','report'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- The status set is load-bearing: the send selector treats 'open' as
-- chaseable, so a typo'd status would either email somebody forever or
-- silence a real task while rendering nowhere.
DO $$ BEGIN
	ALTER TABLE "chase_tasks" ADD CONSTRAINT "chase_task_status_ck" CHECK (status IN ('blocked','open','paused','done','declined','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- A blocked row must say why: an unexplained blocked row is a task nobody
-- will ever unblock, and the nine exhibit-package asks are blocked for a
-- reason a future reader has to be able to read before opening them.
DO $$ BEGIN
	ALTER TABLE "chase_tasks" ADD CONSTRAINT "chase_task_blocked_ck" CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "chase_tasks" ADD CONSTRAINT "chase_task_paused_ck" CHECK (status <> 'paused' OR paused_reason IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- An open row with no opened_at has no time floor, so the detector would
-- accept a submission made long before anyone was asked for it.
DO $$ BEGIN
	ALTER TABLE "chase_tasks" ADD CONSTRAINT "chase_task_open_ck" CHECK (status <> 'open' OR opened_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Terminal status and closed_at move together in both directions, so a
-- half-closed row cannot exist.
DO $$ BEGIN
	ALTER TABLE "chase_tasks" ADD CONSTRAINT "chase_task_closed_ck" CHECK ((status IN ('done','declined','cancelled')) = (closed_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "chase_tasks" ADD CONSTRAINT "chase_task_detector_ck" CHECK (detector IN ('manual','work_submission','work_update_child') AND (detector = 'manual' OR detector_arg IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- ANTI-RESEED RAIL. Nothing else stops a second run of the seed script from
-- inserting the whole register again, after which every assignee would be
-- mailed about the same ask twice a day forever with no constraint violated.
-- Scoped to live rows so a completed ask can legitimately be asked again.
CREATE UNIQUE INDEX IF NOT EXISTS "chase_task_live_uq" ON "chase_tasks"
	(lower(assignee_email), detector, coalesce(detector_arg, ''), lower(title))
	WHERE status IN ('blocked','open','paused');--> statement-breakpoint
-- Exactly the predicate the weekday selector AND the inbound authority gate
-- use, so the two can never drift apart.
CREATE INDEX IF NOT EXISTS "chase_task_due_idx" ON "chase_tasks"
	(lower(assignee_email))
	WHERE status = 'open' AND marked_done_at IS NULL;
