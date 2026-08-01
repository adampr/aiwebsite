// Section-level writes on a draft (§5.17).
//
//   PATCH  — a human edits the text of one section
//   POST   — Tron proposes a revision (returns a PROPOSAL, writes nothing)
//
// THE INVARIANT BOTH PATHS PRESERVE: `cites` and `generatedBy` are carried
// over from the stored section and are never taken from the request body.
// Rule A5 only requires citations when generatedBy === "llm", and rule C1's
// staleness sweep joins on cites, so a write that could clear either field, or
// relabel an llm block as human, would launder an uncited claim past the two
// validators that exist to catch exactly that. Both fail OPEN when cites is
// empty, which is why this is enforced here rather than trusted to a form.

import { reviseSection, brainHealthy } from "@/lib/rfp/brain";
import { logRfpActivity } from "@/lib/rfp/activity";
import {
  getOwnedProposal,
  knowledgeForUser,
  writeProposalSections,
} from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import type { DraftSectionRecord } from "../../../documents/[id]/generate/route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** PATCH — save a human edit to one section's paragraphs. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("PATCH /api/rfp/proposals/[id]/section");
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

  let body: { label?: string; paragraphs?: string[] };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const label = String(body.label ?? "");
  const paragraphs = (Array.isArray(body.paragraphs) ? body.paragraphs : [])
    .filter((p) => typeof p === "string")
    .slice(0, 12)
    .map((p) => p.slice(0, 4000));

  const sections: DraftSectionRecord[] = JSON.parse(proposal.sectionsJson || "[]");
  const at = sections.findIndex((s) => s.label === label);
  if (at < 0) return rfpError("not_found", "No such section.", 404);

  sections[at] = {
    ...sections[at],
    paragraphs,
    // cites and generatedBy deliberately NOT taken from the body. See header.
    cites: sections[at].cites,
    generatedBy: sections[at].generatedBy,
    updatedAt: new Date().toISOString(),
  };

  const ok = await writeProposalSections(
    proposal.id,
    proposal.rev,
    JSON.stringify(sections)
  );
  if (!ok)
    return rfpError(
      "conflict",
      "Someone else changed this draft while you were editing. Reload to see their version.",
      409
    );

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "proposal.section_edit",
    subjectKind: "proposal",
    subjectId: proposal.id,
    meta: { section: label, paragraphs: paragraphs.length },
  });

  return rfpOk({ ok: true, rev: proposal.rev + 1 });
}

/** POST — ask Tron for a revision. Returns a proposal; writes nothing. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/proposals/[id]/section");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();

  let body: { label?: string; instruction?: string };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const label = String(body.label ?? "");
  const instruction = String(body.instruction ?? "").trim();
  if (instruction.length < 3)
    return rfpError("invalid_request", "Say what you want changed.", 400);

  const sections: DraftSectionRecord[] = JSON.parse(proposal.sectionsJson || "[]");
  const section = sections.find((s) => s.label === label);
  if (!section) return rfpError("not_found", "No such section.", 404);

  if (!(await brainHealthy()))
    return rfpError(
      "unavailable",
      "Tron is not responding. Nothing has been changed.",
      503
    );

  const { shared } = await knowledgeForUser(user);
  const result = await reviseSection(
    proposal.id,
    `${section.label} ${section.title}`,
    section.paragraphs,
    instruction,
    shared
  );
  if (!result)
    return rfpError(
      "unavailable",
      "Tron did not return a revision. Nothing has been changed.",
      502
    );

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "proposal.tron_revise",
    subjectKind: "proposal",
    subjectId: proposal.id,
    // The instruction itself is user text and may quote the client's RFP, so
    // only its length is recorded.
    meta: { section: label, instructionChars: instruction.length },
  });

  return rfpOk({
    proposed: result.paragraphs,
    note: result.note,
    current: section.paragraphs,
  });
}
