// POST /api/rfp/proposals/[id]/gap — answer one open question in the draft.
//
// A drafted section records a gap when no fact supported an answer. This
// route takes the human's answer, has the brain weave it into that section
// (a 60-90s call, same sync budget as the Tron revision path), removes the
// answered gap from the record, and returns the updated section so the
// workspace can show the document changing.
//
// Unlike Tron revision this WRITES: the guided answering flow is
// answer-and-see, and the woven result stays a normal section afterwards
// (editable, revisable, un-doable by a PATCH with the previous paragraphs).
// `cites` and `generatedBy` carry over from the stored record, as
// everywhere: an answer must not be able to launder an uncited claim past
// rules A5/C1.
//
// `remember: true` additionally files the answer as PRIVATE proposed
// knowledge (rfp_knowledge_proposals), so the asker's future drafts stop
// asking. It is private until an admin approves it into the shared base.

import { logRfpActivity } from "@/lib/rfp/activity";
import { resolveGap, brainHealthy } from "@/lib/rfp/brain";
import {
  createKnowledgeProposal,
  getOwnedProposal,
  getProposalById,
  knowledgeForUser,
  writeProposalSections,
} from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import type { DraftSectionRecord } from "../../../documents/[id]/generate/route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/proposals/[id]/gap");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();
  if (proposal.status === "sent")
    return rfpError(
      "immutable",
      "A sent proposal is never edited. A correction creates a new one.",
      409
    );

  let body: {
    label?: string;
    question?: string;
    answer?: string;
    remember?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const label = String(body.label ?? "");
  const question = String(body.question ?? "").slice(0, 500);
  const answer = String(body.answer ?? "").trim();
  if (answer.length < 2)
    return rfpError("invalid_request", "Write the answer first.", 400);

  const sections: DraftSectionRecord[] = JSON.parse(
    proposal.sectionsJson || "[]"
  );
  const section = sections.find((s) => s.label === label);
  if (!section) return rfpError("not_found", "No such section.", 404);
  const gapAt = section.gaps.findIndex((g) => g.question === question);
  if (gapAt < 0)
    return rfpError(
      "not_found",
      "That question is no longer open on this section.",
      404
    );

  if (!(await brainHealthy()))
    return rfpError(
      "unavailable",
      "The drafting service is not responding. Nothing has been changed.",
      503
    );

  const { shared } = await knowledgeForUser(user);
  const woven = await resolveGap(
    proposal.id,
    `${section.label} ${section.title}`,
    section.paragraphs,
    question,
    answer,
    shared
  );
  if (!woven)
    return rfpError(
      "unavailable",
      "The answer could not be woven in. Nothing has been changed.",
      502
    );

  // The brain call took a minute; re-read THE SAME ROW the ownership and
  // immutability checks ran against (never newest-for-document, which is
  // unscoped and can be a different row than the one validated), land on
  // the fresh rev, and only if the gap is still open there.
  const fresh = await getProposalById(proposal.id);
  if (!fresh)
    return rfpError("conflict", "This draft changed. Reload.", 409);
  if (fresh.status === "sent")
    return rfpError(
      "immutable",
      "A sent proposal is never edited. A correction creates a new one.",
      409
    );
  const freshSections: DraftSectionRecord[] = JSON.parse(
    fresh.sectionsJson || "[]"
  );
  const at = freshSections.findIndex((s) => s.label === label);
  if (at < 0 || !freshSections[at].gaps.some((g) => g.question === question))
    return rfpError(
      "conflict",
      "That section changed while the answer was being woven in. Reload to see it.",
      409
    );

  const updated: DraftSectionRecord = {
    ...freshSections[at],
    paragraphs: woven.paragraphs,
    gaps: freshSections[at].gaps.filter((g) => g.question !== question),
    cites: freshSections[at].cites,
    generatedBy: freshSections[at].generatedBy,
    updatedAt: new Date().toISOString(),
  };
  freshSections[at] = updated;

  const ok = await writeProposalSections(
    fresh.id,
    fresh.rev,
    JSON.stringify(freshSections)
  );
  if (!ok)
    return rfpError(
      "conflict",
      "This draft changed while the answer was being woven in. Reload.",
      409
    );

  let remembered = false;
  if (body.remember === true) {
    try {
      await createKnowledgeProposal(user, {
        kind: "fact",
        factKey: slug(question) || null,
        category: "general",
        statement: answer.slice(0, 2000),
        detail: `Answered while drafting: ${question}`.slice(0, 2000),
        polarity: "affirmative",
        documentId: proposal.documentId,
        submit: false,
      });
      remembered = true;
    } catch (err) {
      console.error("[rfp] gap remember failed:", err);
    }
  }

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "proposal.gap_resolve",
    subjectKind: "proposal",
    subjectId: proposal.id,
    meta: {
      section: label,
      answerChars: answer.length,
      remaining: freshSections.reduce((n, s) => n + s.gaps.length, 0),
      remembered,
    },
  });

  return rfpOk({
    section: updated,
    note: woven.note,
    remembered,
    rev: fresh.rev + 1,
  });
}
