-- §5.16 archive-store ledger (owner directive 2026-08-19: 100 MB uploads,
-- retained on disk in a store an admin can clean). IF NOT EXISTS guards are
-- the 0044/0046 precedent: a hand-applied catch-up on the VM must not fail
-- the deploy migration; the FK add is wrapped for the same reason (ADD
-- CONSTRAINT has no IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "work_archive_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"rel_path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_archive_files" ADD CONSTRAINT "work_archive_files_submission_id_work_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."work_submissions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_archive_rel_path_uq" ON "work_archive_files" USING btree ("rel_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_archive_sub_idx" ON "work_archive_files" USING btree ("submission_id");
