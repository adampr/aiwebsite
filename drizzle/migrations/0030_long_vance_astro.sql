-- Converge any pre-existing duplicate active proposals BEFORE the unique
-- index lands, or the deploy-time migrate fails on data the race already
-- created. Non-destructive: older duplicates are marked superseded (their
-- sections stay readable), never deleted. Newest (created_at, id) wins.
UPDATE "rfp_proposals" p SET "status" = 'superseded'
WHERE p."status" <> 'superseded'
  AND EXISTS (
    SELECT 1 FROM "rfp_proposals" q
    WHERE q."document_id" = p."document_id"
      AND q."status" <> 'superseded'
      AND (q."created_at" > p."created_at"
           OR (q."created_at" = p."created_at" AND q."id" > p."id"))
  );--> statement-breakpoint
CREATE UNIQUE INDEX "rfp_proposals_doc_active_uq" ON "rfp_proposals" USING btree ("document_id") WHERE status <> 'superseded';
