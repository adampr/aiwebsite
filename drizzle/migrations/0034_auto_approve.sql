ALTER TABLE "work_submissions" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- HAND-ADDED (§5.16 admin web auto-approve, 2026-08-03; 0033 precedent for
-- hand-added statements). The flag is stamped ONLY by the web update route
-- under a Google-verified admin session; the email lane (DKIM-spoofable
-- From) must structurally never arm it. This CHECK makes "auto_approve on a
-- non-update row" impossible at the database, so a future refactor that
-- leaks the option into another createSubmission call site fails loudly
-- instead of publishing a card silently.
ALTER TABLE "work_submissions" ADD CONSTRAINT "work_sub_auto_approve_parent_ck"
  CHECK (auto_approve = false OR parent_id IS NOT NULL);
