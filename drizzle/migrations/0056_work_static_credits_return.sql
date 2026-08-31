-- EXHIBIT CREDITS RETURN, FOLDED INTO PUBLISHED (owner ask 2026-08-31).
-- The Employee Scorecard (/roadmap/scorecard, staff lane) showed "1
-- published" for the builders of the remaining hand-written /work exhibits
-- (Autotask CI Intake; XL Lakehouse and XL API Gateway) because those
-- exhibits are page copy in src/app/work/page.tsx, not work_submissions
-- rows, and scorecardRows counted them for nobody. The owner asked for them
-- to count for their builders. This table returns for that: a row maps a
-- /work section id to a builder's address, and the staff scorecard FOLDS
-- the live-anchor credits into that person's Published count. There is no
-- separate Exhibits column this time; the 2026-08-29 ruling that retired
-- the column stands, only the mechanism behind the count is back.
--
-- THIS MIGRATION CREATES AN EMPTY TABLE AND MUST STAY THAT WAY. The rows
-- map a colleague's email address to an exhibit, and THIS REPOSITORY IS
-- PUBLIC: a seed INSERT here, in a fixture, or in a checked-in map would
-- publish those addresses to the open internet permanently, and git history
-- keeps them after any revert. The rows are written on the production VM by
-- `npm run work:credit`; the pre-commit gate rejects an added line naming
-- this table beside an email address. Same ruling as 0052 and 0054.
--
-- HISTORY. 0052 created this table (2026-08-29); 0055 dropped it later the
-- same day; both are applied history and are not edited. The eight rows
-- exported from production before 0055 ran (a file OUTSIDE the repo, on the
-- VM) all name anchors that had already left the page in the one-tool-one-
-- card conversion, so they counted for nobody then and would count for
-- nobody now: they are NOT to be re-imported. The credits the owner asked
-- for on 2026-08-31 are new rows, written with work:credit add.
--
-- NUMBERED 0056 because 0055 is the journal tail: drizzle applies migrations
-- in journal order and skips a file numbered below the ledger's newest
-- entry in silence, and a snapshot generated below the tail makes the next
-- generate re-emit CREATE TABLE. meta/0056_snapshot.json was generated
-- against 0055's (verified: 0056.prevId equals 0055.id, and the snapshot
-- carries the table again).
--
-- IF NOT EXISTS throughout (0044 onward, 0052 precedent): a hand-applied
-- catch-up on the VM must be able to run this file again without failing
-- the deploy's db:migrate step.
CREATE TABLE IF NOT EXISTS "work_static_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anchor_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_email" text NOT NULL
);--> statement-breakpoint

-- ── HAND-ADDED BELOW (0039/0052/0054 precedent) ─────────────────────────
-- One credit per (exhibit, person): an exhibit can have two builders, so the
-- PAIR is what must be unique, and a PRIMARY KEY on anchor_id alone would
-- make a second builder silently overwrite the first.
--
-- lower(email) is LOAD-BEARING, not cosmetic, and this is the 0039
-- company_people_email_staff_uq form. Every read groups on lower(email), so
-- a raw-column index would accept an address typed with a capital letter
-- beside the same address in lower case, while the reader collapsed the two
-- onto one key: that person's Published count would rise by 2 for a single
-- exhibit, on the page whose entire purpose is being accurate about who
-- built what. Expression indexes are invisible to drizzle-kit, which is why
-- this is hand-added and why deploys must keep using `drizzle-kit migrate`
-- and never `push`. work:credit's upsert targets it with
-- ON CONFLICT (anchor_id, lower(email)), so the index must exist.
CREATE UNIQUE INDEX IF NOT EXISTS "work_static_credit_uq" ON "work_static_credits" ("anchor_id", lower("email"));
