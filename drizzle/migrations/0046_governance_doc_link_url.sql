-- Gov-doc link lane (owner directive 2026-08-18): the admin-provided policy
-- URL. Only ever a parseCheckableUrl-validated http/https href (the scheme
-- gate is the XSS gate; the value renders as an external anchor). IF NOT
-- EXISTS is the 0044 precedent: a hand-applied catch-up on the VM must not
-- fail the deploy migration.
ALTER TABLE "company_governance_docs" ADD COLUMN IF NOT EXISTS "link_url" text;
