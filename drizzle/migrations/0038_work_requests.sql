CREATE TABLE "work_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"requester_user_id" uuid,
	"requester_email" text NOT NULL,
	"requester_name" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"value_usd" integer NOT NULL,
	"metrics_json" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"developer_user_id" uuid,
	"developer_email" text,
	"developer_name" text,
	"claimed_at" timestamp with time zone,
	"marked_complete_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"validated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_requests" ADD CONSTRAINT "work_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_requests" ADD CONSTRAINT "work_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_requests" ADD CONSTRAINT "work_requests_developer_user_id_users_id_fk" FOREIGN KEY ("developer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_req_lane_idx" ON "work_requests" USING btree ("company_id","status","created_at");--> statement-breakpoint
-- HAND-ADDED (§5.19, 2026-08-08; 0033/0034/0035 precedent - drizzle cannot
-- model CHECKs or partial/expression indexes, and `drizzle-kit push` would
-- silently drop them: deploys must keep using `drizzle-kit migrate`).
--
-- The status set is load-bearing: the cap predicates below classify every
-- non-terminal status as "open"/"active", so a typo'd status would count
-- against a person's caps forever while rendering nowhere.
ALTER TABLE "work_requests" ADD CONSTRAINT "work_req_status_ck"
  CHECK (status IN ('pending','approved','in_progress','done_pending','completed','rejected'));
--> statement-breakpoint
ALTER TABLE "work_requests" ADD CONSTRAINT "work_req_value_ck"
  CHECK (value_usd >= 0);
--> statement-breakpoint
-- A claimed row always names its developer: a developer-less in_progress
-- row would hold a 3-cap slot no unclaim predicate can release.
ALTER TABLE "work_requests" ADD CONSTRAINT "work_req_dev_ck"
  CHECK (status NOT IN ('in_progress','done_pending')
         OR (developer_email IS NOT NULL AND claimed_at IS NOT NULL));
--> statement-breakpoint
-- 5-cap count: a requester's OPEN rows per lane (emails are lowercased at
-- the write edge; the expression index is the backstop). Queries branch
-- company_id IS NULL / company_id = $x (inScope pattern), which btree serves.
CREATE INDEX "work_req_requester_open_idx" ON "work_requests"
  (lower(requester_email), "company_id")
  WHERE status NOT IN ('completed','rejected');
--> statement-breakpoint
-- 3-cap count + scorecard "Working On": a developer's ACTIVE rows per lane.
-- done_pending is deliberately inside the predicate (the row holds a cap
-- slot until the admin validates; see §5.19).
CREATE INDEX "work_req_dev_active_idx" ON "work_requests"
  (lower(developer_email), "company_id")
  WHERE status IN ('in_progress','done_pending');
