CREATE TABLE "reported_issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"issue_key" text NOT NULL,
	"severity" text NOT NULL,
	"subject" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'open' NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_emailed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reported_issues_open_key_idx" ON "reported_issues" USING btree ("source","issue_key") WHERE "reported_issues"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reported_issues_status_seen_idx" ON "reported_issues" USING btree ("status","last_seen_at" DESC NULLS LAST);