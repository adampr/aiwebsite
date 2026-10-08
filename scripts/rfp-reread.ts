/**
 * Read one /rfp document again, from the command line (ARCHITECTURE.md
 * §5.17.17).   npm run rfp:reread -- <documentId>
 *
 * The same claim and the same worker as POST /api/rfp/documents/[id]/read,
 * with the read awaited inline instead of in after(). Claimable: a failed
 * read, a stale "reading" row, or an "extracted" row with no section
 * structure. Prints counts and the intake form only, never client text.
 * Exits non-zero when the claim is refused or the read fails.
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { rfpDocuments } from "../src/lib/db/rfp-schema";
import { logRfpActivity } from "../src/lib/rfp/activity";
import { claimReread, isUuid, listRequirements } from "../src/lib/rfp/db";
import { isAutoTitle } from "../src/lib/rfp/doc-title";
import { runDocumentRead } from "../src/lib/rfp/read-document";

async function main(): Promise<number> {
  const docId = process.argv[2] ?? "";
  if (!isUuid(docId)) {
    console.error("usage: npm run rfp:reread -- <documentId>");
    return 2;
  }

  const [before] = await db
    .select({
      status: rfpDocuments.status,
    })
    .from(rfpDocuments)
    .where(eq(rfpDocuments.id, docId))
    .limit(1);
  if (!before) {
    console.error(`refused: no document ${docId}`);
    return 1;
  }

  const row = await claimReread(docId);
  if (!row) {
    console.error(
      before.status === "extracted"
        ? "refused: already extracted with a section structure"
        : before.status === "reading"
          ? "refused: being read now (not yet stale)"
          : `refused: status ${before.status}`
    );
    return 1;
  }

  // An operator at the VM, not the document's owner: the activity log must
  // not claim the owner ran an admin action.
  const actor = { email: "cli", admin: true };
  await logRfpActivity({
    actorEmail: actor.email,
    actorAdmin: actor.admin,
    action: "document.reread",
    subjectKind: "document",
    subjectId: docId,
    meta: { from: before.status, chars: row.rawText.length, via: "cli" },
  });

  await runDocumentRead({
    docId,
    rawText: row.rawText,
    storedTitle: row.title,
    autoTitle: isAutoTitle(row.title, row.sourceName),
    sourceKind: row.sourceKind,
    actor,
  });

  const [after] = await db
    .select({
      status: rfpDocuments.status,
      structureJson: rfpDocuments.structureJson,
      intakeForm: rfpDocuments.intakeForm,
    })
    .from(rfpDocuments)
    .where(eq(rfpDocuments.id, docId))
    .limit(1);
  if (!after || after.status !== "extracted") {
    console.error("read_failed");
    return 1;
  }
  const structure: unknown = after.structureJson ? JSON.parse(after.structureJson) : [];
  const nodes = Array.isArray(structure) ? structure.length : 0;
  const requirements = (await listRequirements(docId)).length;
  console.log(
    `extracted ${requirements} requirements ${nodes} structure nodes form=${after.intakeForm}`
  );
  // Extracted with no structure is still nothing to draft.
  return nodes > 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("rfp:reread failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
