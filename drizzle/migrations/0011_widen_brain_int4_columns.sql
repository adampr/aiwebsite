-- 2026-07-16 fleet Postgres migration follow-up (brain v1.99.2).
-- SQLite INTEGER is 64-bit; the brain's pre-v1.99 PG schema translator
-- created these four columns as 32-bit integer. The SDK's boot-time widen
-- pass heals most columns but cannot ALTER these: two hand-created
-- convenience views (prod-only; definitions verbatim from pg_get_viewdef,
-- backup at /var/lib/postgresql/view-defs-backup-2026-07-16.sql on the VM)
-- depend on them ("cannot alter type of a column used by a view or rule",
-- seen live). Recreate the views around the widen. Everything is
-- conditional so the migration is a no-op wherever the views/tables/int4
-- columns don't exist (dev DBs, fresh installs, re-runs). The drizzle
-- migrator runs this file inside one transaction.
DROP VIEW IF EXISTS "test_ui_issue_reports";--> statement-breakpoint
DROP VIEW IF EXISTS "invocation_records";--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.brain_test_ui_issue_reports') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='brain_test_ui_issue_reports' AND column_name='audio_related' AND data_type='integer') THEN
      ALTER TABLE "brain_test_ui_issue_reports" ALTER COLUMN "audio_related" TYPE bigint;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='brain_test_ui_issue_reports' AND column_name='automated_triage' AND data_type='integer') THEN
      ALTER TABLE "brain_test_ui_issue_reports" ALTER COLUMN "automated_triage" TYPE bigint;
    END IF;
  END IF;
  IF to_regclass('public.brain_invocation_records') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='brain_invocation_records' AND column_name='input_tokens' AND data_type='integer') THEN
      ALTER TABLE "brain_invocation_records" ALTER COLUMN "input_tokens" TYPE bigint;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='brain_invocation_records' AND column_name='output_tokens' AND data_type='integer') THEN
      ALTER TABLE "brain_invocation_records" ALTER COLUMN "output_tokens" TYPE bigint;
    END IF;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.brain_test_ui_issue_reports') IS NOT NULL AND to_regclass('public.test_ui_issue_reports') IS NULL THEN
    EXECUTE 'CREATE VIEW "test_ui_issue_reports" AS SELECT id, created_at, requester_id, session_id, client_message_id, role, issue_code, audio_related, automated_triage, content_snapshot, status, resolved_at, resolution_note, user_description FROM brain_test_ui_issue_reports';
  END IF;
  IF to_regclass('public.brain_invocation_records') IS NOT NULL AND to_regclass('public.invocation_records') IS NULL THEN
    EXECUTE 'CREATE VIEW "invocation_records" AS SELECT id, session_id, provider, selected_model, selection_mode, requester_id, group_id, scope, input_tokens, output_tokens, cost_usd, created_at FROM brain_invocation_records';
  END IF;
END $$;