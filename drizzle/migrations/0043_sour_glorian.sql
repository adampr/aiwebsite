CREATE TABLE "seo_rubric_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"week" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"scorecard_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "seo_rubric_records_week_idx" ON "seo_rubric_records" USING btree ("week");