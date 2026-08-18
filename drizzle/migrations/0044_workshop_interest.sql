CREATE TABLE "workshop_interest" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_interest_email_unique" UNIQUE("email")
);
--> statement-breakpoint
-- Snapshot catch-up, hand-edited to IF NOT EXISTS: the module's v1.91 bump
-- required building this index BY HAND on every host (CREATE INDEX
-- CONCURRENTLY, packages/aicompany/MIGRATIONS.md "All hosts — REQUIRED"),
-- so it already exists on the VM but no drizzle snapshot recorded it; this
-- generate was the first since that bump and drizzle emitted a plain CREATE
-- INDEX that would abort the deploy's db:migrate. On a genuinely fresh DB
-- this builds it (plain, not CONCURRENTLY — an empty table locks for ~0s).
CREATE INDEX IF NOT EXISTS "page_visits_created_at_idx" ON "page_visits" USING btree ("created_at" DESC NULLS LAST);