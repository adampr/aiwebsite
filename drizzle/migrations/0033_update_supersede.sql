ALTER TABLE "work_submissions" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "work_submissions" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_submissions" ADD CONSTRAINT "work_submissions_parent_id_work_submissions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."work_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_sub_parent_idx" ON "work_submissions" USING btree ("parent_id");--> statement-breakpoint
-- HAND-ADDED (§5.16 admin-mediated updates, 2026-08-03; drizzle cannot model
-- partial indexes, 0025 precedent: kept out of schema.ts). One in-flight
-- update per published card. 'failed' is deliberately absent (a pipeline
-- failure must never block a corrected resubmission); the parent-delete
-- guard in the DELETE route covers failed children instead.
CREATE UNIQUE INDEX "work_sub_parent_active_uq" ON "work_submissions" ("parent_id")
  WHERE parent_id IS NOT NULL AND status IN ('received', 'running', 'held', 'pending_approval');
--> statement-breakpoint
-- HAND-ADDED: recreate the 0025 active-title index with pending_approval in
-- the active set (belt-and-braces with work_sub_parent_active_uq: an admin
-- CLI retitle mid-flight is caught by the parent index, a title squat on a
-- pending update is caught by this one). Same transaction, no unguarded
-- window.
DROP INDEX "work_sub_active_title_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "work_sub_active_title_uq" ON "work_submissions"
  (lower(btrim(regexp_replace(title, '\s+', ' ', 'g'))))
  WHERE status IN ('received', 'running', 'held', 'pending_approval');
