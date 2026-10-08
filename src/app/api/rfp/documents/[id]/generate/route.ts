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
import { stripIntakeHeaders } from "@/lib/rfp/intake";
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
  liveReferences,
  writeProposalSections,
  type FactRow,
} from "@/lib/rfp/db";
import {
  referencesAsk,
  referencesGapWhy,
  withReferencesGap,
  type ReferencesAsk,
} from "@/lib/rfp/references-ask";
import {
  capOpenQuestionsForPrompt,
  collectOpenQuestions,
  snapGapQuestions,
} from "@/lib/rfp/gaps";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import type { DraftBlock, GroundFact } from "@/lib/rfp/draft-blocks";
import {
  carryReferencesBlock,
  referencesOtherText,
} from "@/lib/rfp/references-answer";
import {
  keptBlocks,
  landDraftBlocks,
  toGroundFacts,
  withBlocks,
} from "@/lib/rfp/draft-blocks-ops";

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
  /** Stamped by the gap route when the canonical references question is
   *  answered on this section; survives every spread-based edit. A redraft
   *  builds a fresh record and drops it, unless the previous record carried
   *  a `references` block: that block is carried over and the stamp with
   *  it. Read only by the references backstop (references-ask.ts). */
  referencesAnswered?: boolean;
  /** Visual blocks (draft-blocks.ts), each anchored by `after` and carrying
   *  its own cites. ABSENT when there are none, so a prose-only record is
   *  byte-identical to one written before visuals existed. Written only by
   *  this route's landing and the section route's "visuals" op; never read
   *  from a request body. */
  blocks?: DraftBlock[];
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
  // Labels are mutable now (§5.17.1 Tron retitle/remove renames or deletes
  // structure nodes), so membership must be checked at claim time: a stale
  // tab's "Draft this" on a removed or renamed label would otherwise
  // re-create the record under the retired key — a section invisible to
  // every workspace (they render through structure) yet still APPENDED to
  // the exported file by resolve-draft's orphan pass. The letter is the one
  // draftable label with no structure node. (Residual: a remove accepted
  // during the seconds a draft of that same section is in flight can still
  // land an orphan; the Tron plan only targets drafted sections, so the
  // interleaving has no realistic path.)
  if (!isLetter) {
    const structure: { label: string }[] = JSON.parse(
      doc.structureJson || "[]"
    );
    if (!structure.some((n) => n.label === label))
      return rfpError(
        "not_found",
        "That section is no longer part of this document. Reload to see the current structure.",
        404
      );
  }

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
    //
    // ONLY an exact grounded count seeds. An RFP that merely bounds its size
    // ("fewer than 10 employees") is loose evidence: it never prices anything
    // by itself. The workspace asks, showing the staff mentions, and
    // minimumAssumption() only decides whether the one-tap "up to N users at
    // the monthly minimum" answer is the primary button on that question.
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

  // A document read in brief mode (§5.17.17) hands the drafter and the letter
  // the whole text as the author's brief; a structured RFP passes nothing,
  // so its prompts stay byte-identical.
  const briefText =
    doc.intakeForm === "brief" ? stripIntakeHeaders(doc.rawText ?? "") : null;

  after(async () => {
    // Life sign while queued behind the semaphore and while drafting; fenced
    // on the attempt id, so a reclaimed attempt's timer updates nothing.
    const heartbeat = setInterval(() => {
      heartbeatGeneration(proposalId, attemptId).catch(() => {});
    }, HEARTBEAT_MS);
    let landed = false;
    try {
      let drafted: DraftedSection | null = null;
      // Set on the section path only; the letter never carries gap plumbing.
      let refsAsk: ReferencesAsk | null = null;
      let refsWhy = "";
      // What the landing needs to place the system-built visuals (section
      // path only): live SHARED facts, and the structure and asks the two
      // pickers score. The structure is the claim-time read; a retitle
      // accepted mid-draft at worst leaves the snapshot to the workspace's
      // "Add company snapshot" action.
      let sharedGround: GroundFact[] = [];
      let placeStructure: { label: string; title: string }[] = [];
      let placeRequirements: { structureLabel: string; text: string }[] = [];
      let blockCounts = { about: 0, serviceStats: 0, trimmed: 0, landed: 0 };
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
              })),
              briefText !== null
                ? { brief: briefText, contactName: doc.contactName }
                : undefined
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
            // The letter never carries visuals.
            blocks: [],
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
        sharedGround = toGroundFacts(shared);
        placeStructure = JSON.parse(doc.structureJson || "[]");
        placeRequirements = reqs.map((r) => ({
          structureLabel: r.structureLabel ?? "",
          text: r.text,
        }));
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

        // Open questions already on the proposal, from the CLAIM-TIME
        // snapshot: the gen claim serializes draft runs, so no concurrent
        // draft can be ADDING gaps, and claim-time costs zero extra reads.
        // The only concurrent mutation is an answer REMOVING a question;
        // one answered mid-flight at worst gets repeated by the model and
        // lands as its own open entry, which is semantically right (the
        // section still lacked the fact when it drafted).
        const openQuestions = collectOpenQuestions(existing, label);
        // Reserve prompt room for the redrafted section's own gaps (the
        // collector places them last): repeating its own wording is what
        // keeps a merged queue entry stable across a redraft.
        const ownOpenGaps =
          existing.find((s) => s.label === label)?.gaps.length ?? 0;

        drafted = await draftSection(
          proposalId,
          { label, title },
          forSection,
          asFacts,
          capOpenQuestionsForPrompt(openQuestions, ownOpenGaps),
          briefText !== null ? { text: briefText } : undefined
        );

        // The references backstop (references-ask.ts): the drafter never
        // sees rfp_references, so an RFP's ask for references used to be
        // dropped without a trace. Detect it here, deterministically, and
        // build the question's `why` from what the knowledge base holds.
        // One read, only for a section that carries the ask; a failed read
        // costs the shortlist, never the question.
        // The section TITLE is part of the ask: "6. References" often
        // carries it alone.
        refsAsk = drafted ? referencesAsk(forSection, title || label) : null;
        if (refsAsk) {
          const held = await liveReferences().catch((err) => {
            console.error("[rfp] references read failed:", err);
            return null;
          });
          refsWhy = referencesGapWhy(
            refsAsk,
            held,
            `${doc.clientName ?? ""} ${doc.title} ${stripIntakeHeaders(doc.rawText ?? "")}`
          );
        }
      }

      // Land the result, but only while the claim is still THIS attempt's.
      // An edit mid-run bumps rev (retry with the fresh document); a reclaim
      // swaps the attempt id (drop the result, the reclaiming run owns it).
      // The activity log reports the LANDED gap count (post-snap), which
      // can be lower than what the model returned when the snap folds two
      // normalize-equal gaps into one, or one higher when the references
      // backstop adds its question.
      let landedGapCount: number | null = null;
      for (let tries = 0; tries < 3; tries++) {
        const fresh = await getProposalForDocument(doc.id);
        if (!fresh || fresh.genAttemptId !== attemptId) break;
        const sections: DraftSectionRecord[] = JSON.parse(
          fresh.sectionsJson || JSON.stringify(existing)
        );
        if (drafted) {
          const open = collectOpenQuestions(sections, label);
          // Visuals are decided AGAINST THE LANDING STATE too: the company
          // snapshot and the service stats each live on one section, so
          // "does another section hold it" must be asked of the array this
          // write replaces, and a CAS retry asks again. System blocks are
          // rebuilt from live facts here (no model call) and take priority
          // over the drafter's under the per-section cap. A redraft replaces
          // the section's blocks wholesale, like its paragraphs.
          const placed = isLetter
            ? null
            : landDraftBlocks({
                label,
                paragraphCount: drafted.paragraphs.length,
                modelBlocks: drafted.blocks,
                structure: placeStructure,
                requirements: placeRequirements,
                sections,
                sharedFacts: sharedGround,
              });
          if (placed)
            blockCounts = {
              about: placed.about,
              serviceStats: placed.serviceStats,
              trimmed: placed.trimmed,
              landed: placed.blocks.length,
            };
          // The one block a redraft keeps: the person's references (origin
          // "references", built by the references route from their answer,
          // never by the drafter). The drafter's visuals can be rebuilt and
          // the answer cannot, so the others are cut to the cap minus one
          // and the carried block goes LAST, anchored after the last
          // paragraph: it closes the new text. The fresh paragraphs go
          // through the SAME composer the references route uses
          // (references-answer.ts carryReferencesBlock), so the intro and
          // rule D3's etiquette sentence are back after a redraft and D3
          // cannot BLOCK on the carried references. Nothing changes when
          // the previous record carried none.
          const prevAt = sections.findIndex((s) => s.label === label);
          const carriedBlock: DraftBlock | undefined =
            isLetter || prevAt < 0
              ? undefined
              : (keptBlocks(sections[prevAt], drafted.paragraphs.length) ?? []).find(
                  (b) => b.origin === "references"
                );
          const carry = carriedBlock
            ? carryReferencesBlock({
                paragraphs: drafted.paragraphs,
                blocks: placed?.blocks,
                carried: carriedBlock,
                otherText: referencesOtherText(fresh.title, sections, prevAt, {
                  label,
                  title,
                }),
              })
            : null;
          const landedParagraphs = carry ? carry.paragraphs : drafted.paragraphs;
          const landedBlocks = carry ? carry.blocks : placed?.blocks;
          const record: DraftSectionRecord = withBlocks({
            label,
            title,
            paragraphs: landedParagraphs,
            cites: drafted.cites,
            // Snap AGAINST THE LANDING STATE, not the claim snapshot: a
            // question answered while this draft ran must not be re-minted
            // under its old wording, and a CAS retry re-snaps against the
            // fresher array. The target's own previous gaps are still in
            // `sections` here (the splice below replaces them), so a
            // redraft that repeats its own question keeps its wording;
            // other sections' wording wins via collector precedence. The
            // snap list is deliberately UNCAPPED, unlike the prompt list:
            // a paraphrase of a capped-out question still deserves the
            // merge. The letter never carries gap plumbing: its
            // drafted.gaps is the literal [] built above.
            //
            // The references backstop runs BEFORE the snap and against the
            // same landing state: its question is canonical text (or the
            // exact text of a references question already open), so the
            // snap leaves it alone or folds it like any other. It is the
            // one gap the server adds itself, on top of draftSection's cap
            // of two, so a section lands at most three. A redraft of a
            // section whose references were answered as PROSE drops them
            // and re-mints the question (asking again beats losing them);
            // one answered as a references block keeps the block, and the
            // question stays answered.
            gaps: isLetter
              ? drafted.gaps
              : snapGapQuestions(
                  withReferencesGap(drafted.gaps, {
                    ask: refsAsk,
                    paragraphs: drafted.paragraphs,
                    otherSections: sections
                      .filter(
                        (s) => s.label !== label && !s.label.startsWith("__")
                      )
                      .map((s) => s.paragraphs),
                    openQuestions: open,
                    why: refsWhy,
                    // Another section's references question was answered
                    // by a person, or this section's answer is the block
                    // being carried over: never raise it again from here.
                    answeredElsewhere:
                      carry !== null ||
                      sections.some(
                        (s) =>
                          s.label !== label &&
                          !s.label.startsWith("__") &&
                          s.referencesAnswered === true
                      ),
                  }),
                  open
                ),
            // A draft that came back with NO paragraphs while a references
            // block is carried: the record's only prose is the
            // system-written intro, which no fact backs, so it is "human"
            // (rule A5 would otherwise BLOCK on a sentence no model wrote).
            generatedBy: carry?.human ? ("human" as const) : ("llm" as const),
            updatedAt: new Date().toISOString(),
            ...(carry ? { referencesAnswered: true } : {}),
          }, landedBlocks);
          landedGapCount = record.gaps.length;
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
          gaps: landedGapCount ?? drafted?.gaps.length ?? 0,
          // Visuals, counts only: what landed, how many of those the server
          // built, and what the grounding did with the model's.
          blocks: blockCounts.landed,
          blocksAbout: blockCounts.about,
          blocksServiceStats: blockCounts.serviceStats,
          blocksTrimmed: blockCounts.trimmed,
          visualsReturned: drafted?.visualStats?.returned ?? 0,
          visualsDegraded: drafted?.visualStats?.degraded ?? 0,
          visualsDropped: drafted?.visualStats?.dropped ?? 0,
          visualsTooWide: drafted?.visualStats?.tooWide ?? 0,
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
