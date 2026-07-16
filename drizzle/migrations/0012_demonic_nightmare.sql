ALTER TABLE "governance_projects" ADD COLUMN "turn_prompt_id" text;--> statement-breakpoint
ALTER TABLE "governance_projects" ADD COLUMN "turn_attempt_id" text;--> statement-breakpoint
ALTER TABLE "governance_projects" ADD COLUMN "turn_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "governance_projects" ADD COLUMN "turn_json" text;