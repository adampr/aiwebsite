// POST /api/rfp/documents/[id]/generate — draft ONE section.
//
// Deliberately one section per call, not the whole document. A real RFP has
// 17+ sections and one brain call measured at ~94s, so a whole-document run
// would hold half the shared brain semaphore for ~25 minutes, exceed any
// staleness horizon, and die unrecoverably on the next deploy. One section per
// call is resumable, shows progress honestly, and never starves Twilio voice.
//
// Body: { sectionLabel, sectionTitle }

import { after } from "next/server";
import { draftSection, brainHealthy } from "@/lib/rfp/brain";
import { logRfpActivity } from "@/lib/rfp/activity";
import {
  createProposal,
  currentKbVersion,
  getDocument,
  getProposalForDocument,
  knowledgeForUser,
  listRequirements,
  writeProposalSections,
  type FactRow,
} from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

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

  let body: { sectionLabel?: string; sectionTitle?: string };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const label = String(body.sectionLabel ?? "").slice(0, 120);
  const title = String(body.sectionTitle ?? "").slice(0, 300);
  if (!label && !title)
    return rfpError("invalid_request", "Name the section to draft.", 400);

  if (!(await brainHealthy()))
    return rfpError(
      "unavailable",
      "The drafting service is not responding. Nothing has been changed.",
      503
    );

  let proposal = await getProposalForDocument(doc.id);
  if (!proposal) {
    proposal = await createProposal(
      user,
      doc.id,
      doc.title,
      await currentKbVersion()
    );
  }
  if (proposal.genStartedAt)
    return rfpError(
      "busy",
      "A section is already being drafted for this RFP.",
      409
    );

  const proposalId = proposal.id;
  const rev = proposal.rev;
  const existing: DraftSectionRecord[] = JSON.parse(
    proposal.sectionsJson || "[]"
  );

  // Claim, so a second click cannot start a duplicate run.
  const claimed = await writeProposalSections(
    proposalId,
    rev,
    proposal.sectionsJson || "[]",
    { genStartedAt: new Date(), genProgress: label || title, genError: null }
  );
  if (!claimed)
    return rfpError("busy", "That draft changed. Reload and try again.", 409);

  after(async () => {
    try {
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

      const drafted = await draftSection(
        proposalId,
        { label, title },
        forSection,
        asFacts
      );

      const fresh = await getProposalForDocument(doc.id);
      const currentRev = fresh?.rev ?? rev + 1;
      const sections: DraftSectionRecord[] = JSON.parse(
        fresh?.sectionsJson || JSON.stringify(existing)
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
        const at = sections.findIndex((s) => s.label === label && s.title === title);
        if (at >= 0) sections[at] = record;
        else sections.push(record);
      }

      await writeProposalSections(
        proposalId,
        currentRev,
        JSON.stringify(sections),
        {
          genStartedAt: null,
          genProgress: null,
          genError: drafted ? null : "The drafting service returned nothing.",
        }
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
      const fresh = await getProposalForDocument(doc.id).catch(() => null);
      if (fresh)
        await writeProposalSections(
          proposalId,
          fresh.rev,
          fresh.sectionsJson,
          { genStartedAt: null, genError: "Drafting failed." }
        ).catch(() => {});
    }
  });

  return rfpOk({ proposalId, status: "drafting", section: label || title }, 202);
}
