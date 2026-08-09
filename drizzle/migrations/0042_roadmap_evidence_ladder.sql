ALTER TABLE "company_roadmap_links" ADD COLUMN "url_grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_roadmap_links" ADD COLUMN "url_attested_by" text;--> statement-breakpoint
ALTER TABLE "company_roadmap_links" ADD COLUMN "docs_grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "company_roadmap_links" ADD COLUMN "docs_attested_by" text;--> statement-breakpoint
-- ---------------------------------------------------------------------
-- Hand-written from here down (drizzle models neither CHECKs nor partial
-- indexes; 0035 / 0038 / 0039 / 0041 precedent). Keep deploying with
-- `drizzle-kit migrate`, never `push`.
--
-- SAFE ON A NON-EMPTY TABLE, which matters because 0041 is already applied
-- in production: the four columns above are nullable with no default, and
-- every CHECK below is satisfied by every row shape 0041 could have
-- produced (states unchecked/ok/failed, both new columns NULL).
-- ---------------------------------------------------------------------

-- The EVIDENCE LADDER widens the state vocabulary. 'ok' | 'internal' |
-- 'attested' all COUNT; they differ in what evidence we hold, and the copy
-- for each says only what that evidence proves.
ALTER TABLE "company_roadmap_links" DROP CONSTRAINT IF EXISTS "company_roadmap_links_url_state_ck";--> statement-breakpoint
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_url_state_ck"
  CHECK ("url_state" IN ('unchecked','ok','internal','attested','failed'));--> statement-breakpoint

ALTER TABLE "company_roadmap_links" DROP CONSTRAINT IF EXISTS "company_roadmap_links_docs_state_ck";--> statement-breakpoint
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_docs_state_ck"
  CHECK ("docs_state" IN ('unchecked','ok','internal','attested','failed'));--> statement-breakpoint

-- Attribution is the ONLY control on rung 3, so the database refuses an
-- attestation that does not carry a name. Without this, a bug that forgot
-- to pass the actor would produce an anonymous assertion that counts.
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_attested_ck"
  CHECK (("url_state" <> 'attested' OR "url_attested_by" IS NOT NULL)
     AND ("docs_state" <> 'attested' OR "docs_attested_by" IS NOT NULL));--> statement-breakpoint

-- Grace is the hysteresis window and is meaningful only while a field is
-- failing. Anything else means two code paths disagree about the state
-- machine.
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_grace_ck"
  CHECK (("url_grace_until" IS NULL OR "url_state" = 'failed')
     AND ("docs_grace_until" IS NULL OR "docs_state" = 'failed'));--> statement-breakpoint

-- Every COUNTING state describes a stored URL, not just 'ok' as before.
ALTER TABLE "company_roadmap_links" DROP CONSTRAINT IF EXISTS "company_roadmap_links_ok_needs_url_ck";--> statement-breakpoint
ALTER TABLE "company_roadmap_links" ADD CONSTRAINT "company_roadmap_links_ok_needs_url_ck"
  CHECK (("url_state" NOT IN ('ok','internal','attested') OR "url" IS NOT NULL)
     AND ("docs_state" NOT IN ('ok','internal','attested') OR "docs_url" IS NOT NULL));
