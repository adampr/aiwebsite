CREATE TABLE "company_roadmap_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"kind" text NOT NULL,
	"label" text,
	"description" text,
	"url" text,
	"url_state" text DEFAULT 'unchecked' NOT NULL,
	"url_reason" text,
	"url_http_status" integer,
	"url_checked_at" timestamp with time zone,
	"docs_url" text,
	"docs_state" text DEFAULT 'unchecked' NOT NULL,
	"docs_reason" text,
	"docs_http_status" integer,
	"docs_checked_at" timestamp with time zone,
	"environments_json" text,
	"added_by_user_id" uuid,
	"added_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_roadmap_links_company_idx" ON "company_roadmap_links" USING btree ("company_id","kind");--> statement-breakpoint
-- ---------------------------------------------------------------------
-- Hand-written from here down: drizzle-kit models neither CHECK
-- constraints nor PARTIAL unique indexes (0035 / 0038 / 0039 precedent).
-- Keep deploying with `drizzle-kit migrate`, never `push`, or everything
-- below is silently dropped.
-- ---------------------------------------------------------------------

ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_kind_ck"
  CHECK ("kind" IN ('api_proxy','dev_vms','lakehouse','tool'));--> statement-breakpoint

ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_url_state_ck"
  CHECK ("url_state" IN ('unchecked','ok','failed'));--> statement-breakpoint

ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_docs_state_ck"
  CHECK ("docs_state" IN ('unchecked','ok','failed'));--> statement-breakpoint

-- A decided state must carry its evidence. Without this, a row could claim
-- 'ok' with no idea when it was confirmed, and the UI would have to render
-- "verified, at some point, maybe".
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_checked_ck"
  CHECK (("url_state" = 'unchecked' OR "url_checked_at" IS NOT NULL)
     AND ("docs_state" = 'unchecked' OR "docs_checked_at" IS NOT NULL));--> statement-breakpoint

-- 'ok' is only ever true of a URL that actually exists.
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_ok_needs_url_ck"
  CHECK (("url_state" <> 'ok' OR "url" IS NOT NULL)
     AND ("docs_state" <> 'ok' OR "docs_url" IS NOT NULL));--> statement-breakpoint

-- Only a tool card carries a label, and a tool without its own URL is not a
-- tool. dev_vms is the one kind with no primary URL at all: its inputs are
-- the hosting-environment list plus instructions.
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_tool_shape_ck"
  CHECK ("kind" <> 'tool' OR ("label" IS NOT NULL AND "url" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_envs_ck"
  CHECK ("kind" = 'dev_vms' OR "environments_json" IS NULL);--> statement-breakpoint

-- DEFENSE IN DEPTH on a column that is rendered straight into an anchor
-- href. Today the only writer is parseUrlField, which routes through the
-- checker's own parser and refuses any scheme but http/https, so there is
-- no live exploit. This CHECK is here so that stays true after the next
-- person adds a second write path (an import, a backfill, a support script)
-- and does not know that rule: a javascript: or data: value cannot reach
-- the table at all, and therefore cannot reach an href.
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_scheme_ck"
  CHECK (("url" IS NULL OR "url" ~* '^https?://')
     AND ("docs_url" IS NULL OR "docs_url" ~* '^https?://'));--> statement-breakpoint

-- Singleton enforcement lives HERE, not in application code: two concurrent
-- saves both pass a "does one already exist" read, and the loser would
-- create a second api_proxy row that no surface would ever show.
--
-- TWO indexes on purpose. A composite btree treats every NULL company_id
-- row as DISTINCT, so the first index can never dedupe the XL.net staff
-- lane; that is exactly the trap migration 0039 was written to fix for
-- company_people, and it applies verbatim here.
CREATE UNIQUE INDEX "roadmap_links_singleton_uq" ON "company_roadmap_links"
  ("company_id","kind") WHERE "kind" <> 'tool' AND "company_id" IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "roadmap_links_singleton_staff_uq" ON "company_roadmap_links"
  ("kind") WHERE "kind" <> 'tool' AND "company_id" IS NULL;
