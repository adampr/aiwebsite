ALTER TABLE "work_submissions" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
-- HAND-ADDED (§5.16 duplicate-title guard, 2026-07-30; drizzle cannot model
-- expression/partial indexes). Self-clearing: prod already holds duplicate
-- active rows of one title (the owner's triple submission), so all but the
-- OLDEST active row per normalized title are deleted before the index
-- builds. This deterministically performs the planned cleanup.
DELETE FROM work_submissions ws USING (
  SELECT id, row_number() OVER (
    PARTITION BY lower(btrim(regexp_replace(title, '\s+', ' ', 'g')))
    ORDER BY created_at
  ) AS rn
  FROM work_submissions
  WHERE status IN ('received', 'running', 'held')
) d
WHERE ws.id = d.id AND d.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "work_sub_active_title_uq" ON "work_submissions"
  (lower(btrim(regexp_replace(title, '\s+', ' ', 'g'))))
  WHERE status IN ('received', 'running', 'held');
