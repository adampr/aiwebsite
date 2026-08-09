-- §5.16 submission transfer (2026-08-09). submitter_email becomes MOVABLE
-- (it is the current owner), so the per-person daily quota needs an anchor
-- that a move cannot shift: creator_email is stamped once at intake and
-- never rewritten. Deliberately NULLABLE with no backfill and no default —
-- every read is COALESCE(creator_email, submitter_email), so pre-existing
-- rows keep their exact quota meaning and an insert from a process that has
-- not cut over yet still succeeds.
ALTER TABLE "work_submissions" ADD COLUMN "creator_email" text;
