-- Staff governance (owner ruling 2026-08-18): company_id NULL = the XL.net
-- STAFF lane (the 0039 company_people precedent). FK + cascade unchanged; a
-- NULL company_id row simply has no parent to cascade from. No staff-lane
-- partial index: reads are IS NULL over a table bounded by admin-only writes,
-- and the existing btree indexes NULLs anyway. DROP NOT NULL is a no-op when
-- the column is already nullable, so this re-runs safely.
ALTER TABLE "company_governance_docs" ALTER COLUMN "company_id" DROP NOT NULL;
