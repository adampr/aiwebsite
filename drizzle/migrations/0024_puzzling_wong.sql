ALTER TABLE "work_submissions" ADD COLUMN "md_name" text;--> statement-breakpoint
ALTER TABLE "work_submissions" ADD COLUMN "md_sha256" text;--> statement-breakpoint
ALTER TABLE "work_submissions" ADD COLUMN "md_bytes" integer;--> statement-breakpoint
ALTER TABLE "work_submissions" ADD COLUMN "md_data" "bytea";