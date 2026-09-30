// POST /api/rfp/proposals/[id]/references-gap — add the references question
// to a draft that dropped the RFP's ask for references.
//
// The generate route's backstop (references-ask.ts, ARCHITECTURE.md §5.17.2)
// guarantees the question on every section drafted since it shipped. A
// proposal drafted BEFORE it can still sit with an RFP that asks for
// references, no references in the text, and no open question. This route is
// the repair: no brain call, no body. It recomputes the miss from the stored
// requirements and sections and appends the canonical question to each
// asking section, with the same `why` the generate route builds at landing.
//
// IDEMPOTENT: once the question is open (or references are presented, or the
// question was answered) the recompute finds nothing and nothing is written.
// Paragraphs, cites and generatedBy are never touched, and `updatedAt` is
// left alone: a question was added, the section's text did not change.

import { logRfpActivity } from "@/lib/rfp/activity";
import { stripIntakeHeaders } from "@/lib/rfp/intake";
import {
  getDocument,
  getOwnedProposal,
  getProposalById,
  listRequirements,
  liveReferences,
  writeProposalSections,
} from "@/lib/rfp/db";
import { collectOpenQuestions } from "@/lib/rfp/gaps";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import {
  asksAboutReferences,
  referencesAsk,
  referencesGapWhy,
  unansweredReferencesAsks,
  withReferencesGap,
  type ReferenceCandidate,
} from "@/lib/rfp/references-ask";
import type { DraftSectionRecord } from "../../../documents/[id]/generate/route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const IMMUTABLE =
  "A sent proposal is never edited. A correction creates a new one.";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi(
    "POST /api/rfp/proposals/[id]/references-gap"
  );
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();
  if (proposal.status === "sent") return rfpError("immutable", IMMUTABLE, 409);

  const doc = await getDocument(user, proposal.documentId);
  if (!doc) return notFound();
  const requirements = await listRequirements(doc.id);

  // One knowledge-base read, only when something is actually missing; a
  // failed read costs the shortlist, never the question (as at landing).
  let held: ReferenceCandidate[] | null | undefined;
  const rfpText = `${doc.clientName ?? ""} ${doc.title} ${stripIntakeHeaders(doc.rawText ?? "")}`;

  // CAS on rev against THE SAME ROW the ownership check ran on. A write that
  // loses the race (an answer or an edit landed in between) recomputes on the
  // fresh state, so the question is never appended to a stale array.
  for (let tries = 0; tries < 3; tries++) {
    const fresh = await getProposalById(proposal.id);
    if (!fresh) return rfpError("conflict", "This draft changed. Reload.", 409);
    if (fresh.status === "sent") return rfpError("immutable", IMMUTABLE, 409);

    const sections: DraftSectionRecord[] = JSON.parse(
      fresh.sectionsJson || "[]"
    );
    const missing = unansweredReferencesAsks(requirements, sections);
    if (missing.length === 0)
      return rfpOk({ sections, added: [], rev: fresh.rev });

    if (held === undefined)
      held = await liveReferences().catch((err) => {
        console.error("[rfp] references read failed:", err);
        return null;
      });

    const added: string[] = [];
    let count: number | null = null;
    for (const miss of missing) {
      const at = sections.findIndex((s) => s.label === miss.label);
      if (at < 0) continue;
      const section = sections[at];
      // The same detection the generate route runs at landing (title
      // included), so `fromTitle` reaches the why.
      const ask = referencesAsk(
        requirements
          .filter((r) => r.structureLabel === section.label)
          .map((r) => r.text),
        section.title || section.label
      );
      if (!ask) continue;
      const landed = withReferencesGap(section.gaps, {
        ask,
        paragraphs: section.paragraphs,
        otherSections: sections
          .filter((s, i) => i !== at && !s.label.startsWith("__"))
          .map((s) => s.paragraphs),
        // Against the array AS IT STANDS IN THIS LOOP: a second asking
        // section reuses the first one's question byte for byte, so two
        // sections stay ONE question with one answer.
        openQuestions: collectOpenQuestions(sections, section.label),
        why: referencesGapWhy(ask, held ?? null, rfpText),
        answeredElsewhere: sections.some(
          (s, i) =>
            i !== at &&
            !s.label.startsWith("__") &&
            s.referencesAnswered === true
        ),
      });
      if (landed === section.gaps) continue;
      // withReferencesGap is sized for a fresh draft (at most two model gaps
      // survive beside the question). Here the section's open questions are
      // a person's queue, so every one of them is kept; only the question
      // itself, always the last entry, is taken from the result.
      const question = landed[landed.length - 1];
      sections[at] = {
        ...section,
        gaps: [
          ...section.gaps.filter((g) => !asksAboutReferences(g.question)),
          question,
        ],
      };
      added.push(section.label);
      count ??= ask.count;
    }
    if (added.length === 0)
      return rfpOk({ sections, added: [], rev: fresh.rev });

    const ok = await writeProposalSections(
      fresh.id,
      fresh.rev,
      JSON.stringify(sections)
    );
    if (!ok) continue;

    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: user.admin,
      action: "proposal.references_gap_add",
      subjectKind: "proposal",
      subjectId: proposal.id,
      meta: {
        sections: added.length,
        count,
        shortlist: held === null ? "unavailable" : (held?.length ?? 0),
      },
    });

    return rfpOk({ sections, added, rev: fresh.rev + 1 });
  }

  return rfpError(
    "conflict",
    "This draft changed while the question was being added. Reload.",
    409
  );
}
