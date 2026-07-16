CREATE TABLE "governance_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"research_started_at" timestamp with time zone,
	"research_heartbeat_at" timestamp with time zone,
	"research_runs" integer DEFAULT 0 NOT NULL,
	"research_runs_date" date,
	"research_progress_json" text,
	"research_json" text,
	"research_flagged" boolean DEFAULT false NOT NULL,
	"documents_json" text DEFAULT '[]' NOT NULL,
	"transcript_json" text DEFAULT '[]' NOT NULL,
	"covered_bank_ids_json" text DEFAULT '[]' NOT NULL,
	"next_question_json" text,
	"review_summary" text,
	"changed_sections_json" text,
	"answers_count" integer DEFAULT 0 NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"tavily_calls" integer DEFAULT 0 NOT NULL,
	"brain_calls" integer DEFAULT 0 NOT NULL,
	"research_runs" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "governance_projects" ADD CONSTRAINT "governance_projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gov_projects_user_idx" ON "governance_projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gov_projects_activity_idx" ON "governance_projects" USING btree ("last_activity_at");