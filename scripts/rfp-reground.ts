/**
 * Ground the round-32 letterhead and cover fields (and the round-34 subject
 * line) of ONE already-read /rfp document again (ARCHITECTURE.md §5.17.20,
 * §5.17.22).
 *
 *   npm run rfp:reground -- <documentId>
 *
 * rfp:reread only reaches a CLAIMABLE document (a failed read, a stale
 * "reading" row, an "extracted" row with no structure), so a document read
 * before migration 0062 keeps NULL client_address and proposal_headline.
 * This is the lane for those: it re-reads the STORED raw_text through the
 * same reader turn (readRfp, the same grounding and screens) and writes ONLY
 * client_address, proposal_headline and (round 34, migration 0064) rfp_title,
 * each to NULL when the read refuses it. It never touches status, structure,
 * requirements (so never rfp_requirements.client_ref: a client item ID is
 * re-grounded only by a re-read that replaces the requirements, "Read it
 * again" or rfp:reread), titles, the intake form or the contact;
 * claimReread is not used and not changed.
 *
 * rfp_title is the read's grounded-verbatim subject line, the real-RFP cover
 * lede's "in response to your <rfpTitle>" (§5.17.22); written for every
 * intake form, exactly as runDocumentRead writes it (a brief's lede never
 * prints it).
 *
 * The headline is stored only for a document whose STORED intake form is
 * "brief" (a real RFP keeps its composed title), and only when this read
 * also took it as a brief. Prints counts only, never client text.
 *
 * Exit: 2 usage, 1 refused / brain failure / the row changed under the
 * read, 0 written.
 */

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { rfpDocuments } from "../src/lib/db/rfp-schema";
import { logRfpActivity } from "../src/lib/rfp/activity";
import { readRfp } from "../src/lib/rfp/brain";
import { isUuid } from "../src/lib/rfp/db";

async function main(): Promise<number> {
  const docId = process.argv[2] ?? "";
  if (!isUuid(docId)) {
    console.error("usage: npm run rfp:reground -- <documentId>");
    return 2;
  }

  const [row] = await db
    .select({
      status: rfpDocuments.status,
      rawText: rfpDocuments.rawText,
      sourceKind: rfpDocuments.sourceKind,
      intakeForm: rfpDocuments.intakeForm,
      updatedAt: rfpDocuments.updatedAt,
    })
    .from(rfpDocuments)
    .where(eq(rfpDocuments.id, docId))
    .limit(1);
  if (!row) {
    console.error(`refused: no document ${docId}`);
    return 1;
  }
  // A read in flight (or a failed one) is rfp:reread's, not this lane's.
  if (row.status !== "extracted") {
    console.error(`refused: status ${row.status} (rfp:reground needs an extracted document; use rfp:reread)`);
    return 1;
  }
  const rawText = row.rawText ?? "";
  if (rawText.trim() === "") {
    console.error("refused: no stored text to read");
    return 1;
  }

  const result = await readRfp(docId, rawText, row.sourceKind);
  if (!result) {
    console.error("read_failed (brain): nothing written");
    return 1;
  }

  const clientAddress = result.clientAddress ?? null;
  const proposalHeadline =
    row.intakeForm === "brief" && result.intakeForm === "brief"
      ? (result.proposalHeadline ?? null)
      : null;

  // Same overwrite rule as runDocumentRead: a read that grounds none is NULL.
  const rfpTitle = result.rfpTitle ?? null;

  // Only these three columns, and only if nothing rewrote the row while the
  // brain was reading (a re-read, a retitle, an archive bump updatedAt).
  const written = await db
    .update(rfpDocuments)
    .set({ clientAddress, proposalHeadline, rfpTitle })
    .where(
      and(
        eq(rfpDocuments.id, docId),
        eq(rfpDocuments.status, "extracted"),
        eq(rfpDocuments.updatedAt, row.updatedAt)
      )
    )
    .returning({ id: rfpDocuments.id });
  if (written.length === 0) {
    console.error("refused: the document changed during the read; nothing written");
    return 1;
  }

  const addressLines = clientAddress ? clientAddress.split("\n").length : 0;
  const headline = proposalHeadline ? "ok" : "none";
  const subject = rfpTitle ? "ok" : "none";
  // An operator at the VM, not the document's owner. Shape only.
  await logRfpActivity({
    actorEmail: "cli",
    actorAdmin: true,
    action: "document.reground",
    subjectKind: "document",
    subjectId: docId,
    meta: { addressLines, headline, rfpTitle: subject, form: row.intakeForm, readForm: result.intakeForm, via: "cli" },
  });
  console.log(
    `reground addressLines=${addressLines} headline=${headline} rfpTitle=${subject} form=${row.intakeForm} readForm=${result.intakeForm}`
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // A fixed message on purpose: a driver error's message can echo the query
    // params, which here are the address, headline and subject-line text.
    console.error(
      "rfp:reground failed:",
      err instanceof Error ? err.constructor.name : "unknown error"
    );
    process.exit(1);
  });
