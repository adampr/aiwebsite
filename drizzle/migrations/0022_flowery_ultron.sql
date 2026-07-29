CREATE TABLE "work_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"submitter_email" text NOT NULL,
	"submitter_name" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"blurb" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"architecture_text" text,
	"skill_md_text" text,
	"file_manifest_json" text,
	"corpus_files_json" text,
	"archive_name" text,
	"archive_sha256" text,
	"archive_bytes" integer,
	"panel_attempt_id" text,
	"panel_started_at" timestamp with time zone,
	"panel_heartbeat_at" timestamp with time zone,
	"panel_runs" integer DEFAULT 0 NOT NULL,
	"panel_runs_date" date,
	"panel_progress_json" text,
	"panel_transcript_json" text,
	"panel_error" text,
	"card_json" text,
	"slug" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"brain_calls" integer DEFAULT 0 NOT NULL,
	"panel_runs" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_submissions" ADD CONSTRAINT "work_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_sub_user_idx" ON "work_submissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "work_sub_status_idx" ON "work_submissions" USING btree ("status","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_sub_slug_uq" ON "work_submissions" USING btree ("slug");