/**
 * Compose the thematic part titles and deks of ONE brief-mode /rfp proposal
 * (ARCHITECTURE.md §5.17.21, round 33).
 *
 *   npm run rfp:parts -- <proposalId>
 *
 * The letter turn composes parts_json when it lands, so a brief proposal
 * whose letter was drafted before migration 0063 (or was edited by hand,
 * which blocks a letter redraft) keeps NULL and renders the static part
 * titles. This is the lane for those: it reads the STORED drafted sections
 * and sends them through the parts-only brain turn (composeProposalParts:
 * the letter turn's own parts ask, the same evidence plus each part's
 * visual text, the same screens) and
 * writes ONLY parts_json, under CAS on rev. It never writes or rewrites the
 * letter, a section, a title, the structure or the gate.
 *
 * Refuses a real RFP (only an intake form of "brief" has parts), a proposal
 * with fewer than 2 drafted non-letter sections, a superseded proposal and
 * one with a draft in flight. Prints counts only, never document text or
 * environment values.
 *
 * Exit: 2 usage, 1 refused / brain failure / the row changed under the
 * compose, 0 written.
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { rfpDocuments } from "../src/lib/db/rfp-schema";
import { logRfpActivity } from "../src/lib/rfp/activity";
import { composeProposalParts, partsWithSections } from "../src/lib/rfp/brain";
import {
  genClaimActive,
  getProposalById,
  isUuid,
  writeProposalParts,
} from "../src/lib/rfp/db";
import { stripIntakeHeaders } from "../src/lib/rfp/intake";
import { splitSections } from "../src/lib/rfp/letter";
import { serializePartsJson } from "../src/lib/rfp/outline";
import type { DraftSectionRecord } from "../src/app/api/rfp/documents/[id]/generate/route";

/** Drafted non-letter sections a proposal needs before it has parts to name. */
const MIN_SECTIONS = 2;

async function main(): Promise<number> {
  const proposalId = process.argv[2] ?? "";
  if (!isUuid(proposalId)) {
    console.error("usage: npm run rfp:parts -- <proposalId>");
    return 2;
  }

  const proposal = await getProposalById(proposalId);
  if (!proposal) {
    console.error(`refused: no proposal ${proposalId}`);
    return 1;
  }
  if (proposal.status === "superseded") {
    console.error("refused: the proposal is superseded");
    return 1;
  }
  if (genClaimActive(proposal)) {
    console.error("refused: a draft is in flight; run again once it lands");
    return 1;
  }

  const [doc] = await db
    .select({
      status: rfpDocuments.status,
      intakeForm: rfpDocuments.intakeForm,
      rawText: rfpDocuments.rawText,
      clientName: rfpDocuments.clientName,
      contactName: rfpDocuments.contactName,
      title: rfpDocuments.title,
    })
    .from(rfpDocuments)
    .where(eq(rfpDocuments.id, proposal.documentId))
    .limit(1);
  if (!doc) {
    console.error("refused: the proposal's document is gone");
    return 1;
  }
  // Parts are a brief document's layout only: a real RFP keeps the legacy
  // two-divider layout and never stores parts_json.
  if (doc.intakeForm !== "brief") {
    console.error(`refused: intake form ${doc.intakeForm} (parts exist for brief documents only)`);
    return 1;
  }

  let records: DraftSectionRecord[];
  try {
    const parsed: unknown = JSON.parse(proposal.sectionsJson || "[]");
    if (!Array.isArray(parsed)) throw new TypeError("not an array");
    records = parsed as DraftSectionRecord[];
  } catch {
    console.error("refused: the stored sections do not parse");
    return 1;
  }
  const sections = splitSections(records)
    .sections.filter((s) => s && typeof s.label === "string" && Array.isArray(s.paragraphs))
    .map((s) => ({
      label: s.label,
      title: typeof s.title === "string" ? s.title : "",
      paragraphs: s.paragraphs.filter((p): p is string => typeof p === "string"),
      ...(Array.isArray(s.blocks) ? { blocks: s.blocks } : {}),
    }));
  if (sections.length < MIN_SECTIONS) {
    console.error(
      `refused: ${sections.length} drafted section(s); rfp:parts needs at least ${MIN_SECTIONS}`
    );
    return 1;
  }

  const parts = await composeProposalParts(
    proposal.id,
    doc.clientName,
    doc.title,
    sections,
    { brief: stripIntakeHeaders(doc.rawText ?? ""), contactName: doc.contactName }
  );
  if (!parts) {
    console.error("compose_failed (brain): nothing written");
    return 1;
  }

  // Only parts_json, and only if nothing rewrote the proposal while the
  // brain composed (an edit, a draft claim, a gate run bump rev).
  const written = await writeProposalParts(proposal.id, proposal.rev, serializePartsJson(parts));
  if (!written) {
    console.error("refused: the proposal changed during the compose; nothing written");
    return 1;
  }

  const titles = parts.filter((p) => p.title !== null).length;
  const deks = parts.filter((p) => p.dek !== null).length;
  const asked = partsWithSections(sections).length;
  // An operator at the VM, not the proposal's owner. Shape only.
  await logRfpActivity({
    actorEmail: "cli",
    actorAdmin: true,
    action: "proposal.parts",
    subjectKind: "proposal",
    subjectId: proposal.id,
    meta: { parts: asked, titles, deks, sections: sections.length, via: "cli" },
  });
  console.log(`parts parts=${asked} titles=${titles} deks=${deks} sections=${sections.length}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // A fixed message on purpose: a driver error's message can echo the query
    // params, which here are the composed part titles and deks.
    console.error(
      "rfp:parts failed:",
      err instanceof Error ? err.constructor.name : "unknown error"
    );
    process.exit(1);
  });
