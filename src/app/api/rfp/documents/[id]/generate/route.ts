// POST /api/rfp/documents/[id]/generate — draft ONE section.
//
// Deliberately one section per call, not the whole document. A real RFP has
// 17+ sections and one brain call measured at ~94s, so a whole-document run
// would hold half the shared brain semaphore for ~25 minutes, exceed any
// staleness horizon, and die unrecoverably on the next deploy. One section per
// call is resumable, shows progress honestly, and never starves Twilio voice.
//
// Body: { sectionLabel, sectionTitle }

import crypto from "node:crypto";
import { after } from "next/server";
import {
  draftCoverLetter,
  draftSection,
  brainHealthy,
  type DraftedSection,
} from "@/lib/rfp/brain";
import { LETTER_LABEL, LETTER_TITLE, splitSections } from "@/lib/rfp/letter";
import { logRfpActivity } from "@/lib/rfp/activity";
import {
  clearGenClaim,
  completeGeneration,
  createProposal,
  currentKbVersion,
  genClaimActive,
  getDocument,
  getProposalForDocument,
  heartbeatGeneration,
  knowledgeForUser,
  listRequirements,
  writeProposalSections,
  type FactRow,
} from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

const HEARTBEAT_MS = 60 * 1000;

export const dynamic = "force-dynamic";
export const revalidate = 0;

export type DraftSectionRecord = {
  label: string;
  title: string;
  paragraphs: string[];
  /** Fact ids. Preserved verbatim through every later edit: rules A5 and C1
   *  both read this, and both fail OPEN when it is empty. */
  cites: string[];
  gaps: { question: string; why: string }[];
  generatedBy: "llm" | "human";
  updatedAt: string;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/documents/[id]/generate");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const doc = await getDocument(user, id);
  if (!doc) return notFound();

  let body: { sectionLabel?: string; sectionTitle?: string; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const label = String(body.sectionLabel ?? "").slice(0, 120);
  // "__" labels are reserved for host furniture records in sectionsJson.
  // Only the letter is draftable; readRfp strips the prefix from client
  // labels, so anything else arriving here is a forged request.
  const isLetter = label === LETTER_LABEL;
  if (label.startsWith("__") && !isLetter)
    return rfpError("invalid_request", "No such section.", 400);
  const title = isLetter
    ? LETTER_TITLE
    : String(body.sectionTitle ?? "").slice(0, 300);
  if (!label && !title)
    return rfpError("invalid_request", "Name the section to draft.", 400);

  if (!(await brainHealthy()))
    return rfpError(
      "unavailable",
      "The drafting service is not responding. Nothing has been changed.",
      503
    );

  // No proposal before extraction lands: a proposal created against a
  // half-read document would miss the stated-staff seed below, resurrecting
  // the "how many users" question on an RFP that answers it.
  if (doc.status !== "extracted")
    return rfpError(
      "busy",
      "Still reading the RFP. Try again once the structure is out.",
      409
    );

  let proposal = await getProposalForDocument(doc.id);
  if (!proposal) {
    // Owner ruling 2026-08-02: a stated staff count IS the fully managed
    // user count until staff says otherwise, so the workspace never asks
    // for a number the RFP already states. statesHeadcountOnly stays false
    // (single illustration); the manual checkbox re-arms B4 untouched.
    // fullyManagedUsersSource is read by the workspace for provenance and
    // deliberately does NOT survive parseQuoteInputs, so a client PUT can
    // never mint it (the pricing route re-derives it instead).
    const seed = doc.statedStaffCount
      ? JSON.stringify({
          fullyManagedUsers: doc.statedStaffCount,
          fullyManagedUsersSource: "rfp",
        })
      : null;
    proposal = await createProposal(
      user,
      doc.id,
      doc.title,
      await currentKbVersion(),
      seed
    );
  }
  if (genClaimActive(proposal))
    return rfpError(
      "busy",
      "A section is already being drafted for this RFP.",
      409
    );

  const proposalId = proposal.id;
  const rev = proposal.rev;
  const attemptId = crypto.randomUUID();
  const existing: DraftSectionRecord[] = JSON.parse(
    proposal.sectionsJson || "[]"
  );

  // The letter is drafted LAST by design (owner directive 2026-08-02): it
  // summarizes the drafted sections, so with none drafted there is nothing
  // to write and the old two-sentence letter was the result.
  if (isLetter && splitSections(existing).sections.length === 0)
    return rfpError(
      "not_ready",
      "Draft the response sections first. The cover letter is written last, as a summary of them.",
      409
    );

  // A hand-edited letter is only replaced on an EXPLICIT ask (the letter
  // page's redraft button sends force). The draft-all loop never sends it,
  // so no automated run — this tab's or a stale second tab's — can clobber
  // a human's reviewed letter. Server-side because the client's own guard
  // reads state that can be minutes old.
  if (
    isLetter &&
    !body.force &&
    splitSections(existing).letter?.generatedBy === "human"
  )
    return rfpError(
      "human_letter",
      "The cover letter was edited by hand. Use the letter's redraft button to replace it.",
      409
    );

  // Claim, so a second click cannot start a duplicate run. Reclaiming a
  // stale attempt goes through the same CAS: the new attempt id is what
  // invalidates the dead worker's eventual write.
  const claimed = await writeProposalSections(
    proposalId,
    rev,
    proposal.sectionsJson || "[]",
    {
      genStartedAt: new Date(),
      genAttemptId: attemptId,
      genHeartbeatAt: new Date(),
      // The letter's reserved label must never surface in a progress line
      // ("Drafting __letter"); its title reads right everywhere.
      genProgress: isLetter ? title : label || title,
      genError: null,
    }
  );
  if (!claimed)
    return rfpError("busy", "That draft changed. Reload and try again.", 409);

  after(async () => {
    // Life sign while queued behind the semaphore and while drafting; fenced
    // on the attempt id, so a reclaimed attempt's timer updates nothing.
    const heartbeat = setInterval(() => {
      heartbeatGeneration(proposalId, attemptId).catch(() => {});
    }, HEARTBEAT_MS);
    let landed = false;
    try {
      let drafted: DraftedSection | null = null;
      if (isLetter) {
        // The letter drafts from the sections AS THEY ARE NOW, not as they
        // were at claim time: in the draft-all run it is the last step, and
        // the whole point is summarizing what just landed.
        const now = await getProposalForDocument(doc.id);
        const current = splitSections(
          JSON.parse(now?.sectionsJson || "[]") as DraftSectionRecord[]
        ).sections;
        const letter = current.length
          ? await draftCoverLetter(
              proposalId,
              doc.clientName,
              doc.title,
              current.map((s) => ({
                label: s.label,
                title: s.title,
                paragraphs: s.paragraphs,
              }))
            )
          : null;
        if (letter)
          drafted = {
            paragraphs: letter.paragraphs,
            // A summary's support is the sections it summarizes: the union
            // of their citations, deterministic, never model-chosen. This is
            // recorded PROVENANCE, not a validated control: A5/C1 are
            // block-scoped and never read the letter record (resolve-draft
            // routes it into furniture); the letter's claims are covered
            // transitively by the sections' own cited blocks plus the span
            // scans (D1/D2/B7) over the letter body.
            cites: [...new Set(current.flatMap((s) => s.cites))].slice(0, 60),
            gaps: [],
          };
      } else {
        const reqs = await listRequirements(doc.id);
        const forSection = reqs
          .filter((r) => !label || r.structureLabel === label)
          .map((r) => r.text);

        // The user's own private knowledge is included for THEIR draft only,
        // mapped onto the fact shape with needs-adam confidence so the drafter
        // treats it as provisional. Nobody else's private knowledge is visible.
        const { shared, mine } = await knowledgeForUser(user);
        const asFacts: FactRow[] = [
          ...shared,
          ...mine.map(
            (m) =>
              ({
                id: `pending_${m.id}`,
                key: m.factKey ?? "pending",
                category: m.category,
                statement: m.statement,
                polarity: m.polarity,
                detail: m.detail,
                sourceUrl: null,
                verifiedAt: null,
                correctedAt: null,
                supersedes: null,
                introducedInKb: 0,
                retiredInKb: null,
                confidence: "needs-adam",
              }) as FactRow
          ),
        ];

        drafted = await draftSection(
          proposalId,
          { label, title },
          forSection,
          asFacts
        );
      }

      // Land the result, but only while the claim is still THIS attempt's.
      // An edit mid-run bumps rev (retry with the fresh document); a reclaim
      // swaps the attempt id (drop the result, the reclaiming run owns it).
      for (let tries = 0; tries < 3; tries++) {
        const fresh = await getProposalForDocument(doc.id);
        if (!fresh || fresh.genAttemptId !== attemptId) break;
        const sections: DraftSectionRecord[] = JSON.parse(
          fresh.sectionsJson || JSON.stringify(existing)
        );
        if (drafted) {
          const record: DraftSectionRecord = {
            label,
            title,
            paragraphs: drafted.paragraphs,
            cites: drafted.cites,
            gaps: drafted.gaps,
            generatedBy: "llm",
            updatedAt: new Date().toISOString(),
          };
          // Identity is LABEL alone, as everywhere else (workspace join,
          // section/gap routes, resolve-draft); matching on title too made
          // a retitled node land a duplicate label.
          const at = sections.findIndex((s) => s.label === label);
          if (at >= 0) sections[at] = record;
          else sections.push(record);
        }
        landed = await completeGeneration(
          proposalId,
          fresh.rev,
          attemptId,
          JSON.stringify(sections),
          drafted
            ? {}
            : { genError: "The drafting service returned nothing." }
        );
        if (landed) break;
      }
      // Rev CAS lost three times (or the claim moved on): the result is
      // dropped, but the claim must not sit until the stale horizon with no
      // error — clear it, fenced on the attempt id only.
      if (!landed)
        await clearGenClaim(
          proposalId,
          attemptId,
          drafted
            ? "The draft finished but could not be saved. Draft this section again."
            : "The drafting service returned nothing."
        );

      await logRfpActivity({
        actorEmail: user.email,
        actorAdmin: user.admin,
        action: "proposal.generate",
        subjectKind: "proposal",
        subjectId: proposalId,
        outcome: drafted ? "ok" : "error",
        meta: {
          section: label || title,
          paragraphs: drafted?.paragraphs.length ?? 0,
          cites: drafted?.cites.length ?? 0,
          gaps: drafted?.gaps.length ?? 0,
        },
      });
    } catch (err) {
      console.error("[rfp] generate failed:", err);
      await clearGenClaim(proposalId, attemptId, "Drafting failed.").catch(
        () => {}
      );
    } finally {
      clearInterval(heartbeat);
    }
  });

  return rfpOk({ proposalId, status: "drafting", section: label || title }, 202);
}
