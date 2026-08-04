CREATE TABLE "magic_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "magic_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_by_email" text NOT NULL,
	"apollo_last_import_at" timestamp with time zone,
	"apollo_last_import_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_admin_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"requester_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"notified_emails_json" text,
	"decided_by_user_id" uuid,
	"decided_by_email" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_admins" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_via" text NOT NULL,
	"granted_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_governance_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"file_name" text,
	"file_mime" text,
	"file_sha256" text,
	"file_bytes" integer,
	"file_data" "bytea",
	"doc_text" text,
	"governance_project_id" text,
	"governance_kind" text,
	"added_by_user_id" uuid,
	"added_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"apollo_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "directory_suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"email_sha256" text NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"apollo_calls" integer DEFAULT 0 NOT NULL,
	"brain_calls" integer DEFAULT 0 NOT NULL,
	"panel_runs" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_submissions" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_admin_requests" ADD CONSTRAINT "company_admin_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_admin_requests" ADD CONSTRAINT "company_admin_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_admin_requests" ADD CONSTRAINT "company_admin_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_admins" ADD CONSTRAINT "company_admins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_admins" ADD CONSTRAINT "company_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_governance_docs" ADD CONSTRAINT "company_governance_docs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_governance_docs" ADD CONSTRAINT "company_governance_docs_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_people" ADD CONSTRAINT "company_people_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_suppressions" ADD CONSTRAINT "directory_suppressions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_domain_uq" ON "companies" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "company_admin_req_company_idx" ON "company_admin_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "company_admins_member_uq" ON "company_admins" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "company_admins_user_idx" ON "company_admins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "company_gov_docs_company_idx" ON "company_governance_docs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_people_company_idx" ON "company_people" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_suppr_uq" ON "directory_suppressions" USING btree ("company_id","email_sha256");--> statement-breakpoint
ALTER TABLE "work_submissions" ADD CONSTRAINT "work_submissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_sub_company_idx" ON "work_submissions" USING btree ("company_id","status","published_at");--> statement-breakpoint
-- HAND-ADDED (§5.18, 2026-08-04; 0033/0034 precedent — drizzle cannot model
-- CHECKs or partial/expression indexes, and `drizzle-kit push` would drop
-- them: deploys must keep using `drizzle-kit migrate`).
--
-- Structural backstop for the tenancy key: a companies row for xl.net or
-- ai.xl.net would shadow the staff email-intake lane, and *.onmicrosoft.com
-- addresses are mintable by any free Entra tenant (a row there would make a
-- shared mailbox population one "company"). Freemail exclusion is enforced
-- twice in code (bootstrap eligibility AND every routing lookup), not here:
-- the list is long and living, and a stale DB copy would block legitimate
-- fixes.
ALTER TABLE "companies" ADD CONSTRAINT "companies_domain_ck"
  CHECK (domain = lower(domain)
         AND domain NOT IN ('xl.net', 'ai.xl.net')
         AND domain NOT LIKE '%.onmicrosoft.com');
--> statement-breakpoint
-- One pending admin-access request per requester per company. Denied rows
-- deliberately do not block (the refusal window for a denied requester is
-- enforced in code against the denied row's expires_at).
CREATE UNIQUE INDEX "company_admin_req_pending_uq" ON "company_admin_requests"
  ("company_id", "requester_user_id") WHERE status = 'pending';
--> statement-breakpoint
-- Directory dedupe: one row per email per company (emails are lowercased at
-- the write edge; the expression index is the backstop), one row per Apollo
-- person per company (the re-import upsert key).
CREATE UNIQUE INDEX "company_people_email_uq" ON "company_people"
  ("company_id", lower(email)) WHERE email IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "company_people_apollo_uq" ON "company_people"
  ("company_id", "apollo_id") WHERE apollo_id IS NOT NULL;
--> statement-breakpoint
-- Title uniqueness becomes per-tenant: the staff lane (company_id NULL) is
-- its own namespace via COALESCE, so two companies can both publish an
-- "Outage Checker" without colliding with each other or with XL.net. Index
-- NAMES stay identical to 0033 so isUniqueViolation call sites keep working
-- untouched. WHERE predicates are byte-identical to 0033 with only the
-- COALESCE prefix added.
DROP INDEX "work_sub_active_title_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "work_sub_active_title_uq" ON "work_submissions"
  (COALESCE(company_id::text, 'staff'),
   lower(btrim(regexp_replace(title, '\s+', ' ', 'g'))))
  WHERE status IN ('received', 'running', 'held', 'pending_approval');
--> statement-breakpoint
DROP INDEX "work_sub_parent_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "work_sub_parent_active_uq" ON "work_submissions"
  (COALESCE(company_id::text, 'staff'), "parent_id")
  WHERE parent_id IS NOT NULL AND status IN ('received', 'running', 'held', 'pending_approval');
--> statement-breakpoint
-- v1 ships NO company update lane: an update CHILD can never carry a
-- company_id, which transitively (0034's auto_approve CHECK) makes company
-- auto_approve doubly impossible. This covers only the child side — the
-- update route additionally refuses company PARENTS in code, and
-- publishWithSupersede requires the parent's company_id IS NULL inside its
-- transaction, so a NULL-company child can never swap a company card public.
ALTER TABLE "work_submissions" ADD CONSTRAINT "work_sub_company_no_update_ck"
  CHECK (company_id IS NULL OR parent_id IS NULL);
