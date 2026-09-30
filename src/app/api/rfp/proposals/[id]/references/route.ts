// /api/rfp/proposals/[id]/references (ARCHITECTURE.md §5.17.10)
//
// GET  what the knowledge base holds, ranked for this RFP, WITH the contact
//      columns: the picker prefills them for a staff member behind the /rfp
//      gate. This response is the only place those values leave the database;
//      every read is logged (`reference.contacts_read`, a count only).
// POST the answer to the references question: the structured entries the
//      person picked and checked. No brain call. The section gains one intro
//      paragraph and ONE `references` block (references-block.ts) that every
//      surface draws the cards from; every references question closes on
//      every section; with `keep` the contacts are written back to
//      rfp_references (update the live row a `referenceId` names or whose
//      organization matches, else create a row; only non-empty fields are
//      written).
//      With `replace: true` it EDITS an answer already given: the section
//      named by `label` must hold a references block, `question` is ignored,
//      and the card set is replaced in place (same slot, same anchor, no
//      second intro).
//
// A `referenceId` is never trusted: a duplicate in one request is refused, an
// unknown or retired id becomes null, and a known id has the entry's
// organization OVERWRITTEN with the row's (the picker locks that field; the
// API enforces it).
//
// The record-building is references-answer.ts (pure, the gate tests run the
// same composition).
//
// Contact values travel in the document and this route's own responses and
// nowhere else: never in a log line, never in activity meta (ids and counts
// only), never in an error message.

import { logRfpActivity } from "@/lib/rfp/activity";
import { stripIntakeHeaders } from "@/lib/rfp/intake";
import {
  getDocument,
  getOwnedProposal,
  getProposalById,
  liveReferenceOrganizations,
  liveReferencesWithContacts,
  saveReferenceContacts,
  writeProposalSections,
} from "@/lib/rfp/db";
import { LIMITS, sanitizeStoredBlocks } from "@/lib/rfp/draft-blocks";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import {
  asksAboutReferences,
  isReferencesGapQuestion,
  rankReferenceCandidates,
} from "@/lib/rfp/references-ask";
import {
  applyReferencesAnswer,
  closeReferencesQuestions,
  referencesOtherText,
} from "@/lib/rfp/references-answer";
import {
  readReferenceEntries,
  readReferenceEntry,
  REFERENCE_LIMITS,
  type ReferenceCandidateWire,
  type ReferenceEntry,
  type ReferencesGetResponse,
  type ReferencesPostBody,
} from "@/lib/rfp/references-block";
import type { DraftSectionRecord } from "../../../documents/[id]/generate/route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const IMMUTABLE =
  "A sent proposal is never edited. A correction creates a new one.";
const CHANGED =
  "That section changed while the references were being added. Reload to see it.";
const NOTHING_TO_EDIT = "There are no references on this section to edit.";

/** Does this stored record hold a readable references block? */
function holdsReferences(s: DraftSectionRecord): boolean {
  return sanitizeStoredBlocks(s.blocks, s.paragraphs.length).some(
    (b) => b.origin === "references"
  );
}
/** Ranked by segment against the RFP, stable otherwise; the wire rows themselves, untouched. */
function rankForRfp(
  rows: ReferenceCandidateWire[],
  rfpText: string
): ReferenceCandidateWire[] {
  return rankReferenceCandidates(
    rows.map((r, i) => ({
      i,
      organization: r.organization,
      segment: r.segment,
      relationshipSince: r.relationshipSince,
      usableWithoutAsking: r.usableWithoutAsking,
      hasContact: Boolean(r.contactPhone?.trim() || r.contactEmail?.trim()),
    })),
    rfpText
  ).map((x) => rows[x.i]);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("GET /api/rfp/proposals/[id]/references");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();
  const doc = await getDocument(user, proposal.documentId);
  if (!doc) return notFound();

  const rfpText = `${doc.clientName ?? ""} ${doc.title} ${stripIntakeHeaders(doc.rawText ?? "")}`;
  const candidates = rankForRfp(await liveReferencesWithContacts(), rfpText);
  // The one read of third-party contact values is on the record: who, for
  // which proposal, how many rows. Never a value, never an organization.
  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "reference.contacts_read",
    subjectKind: "proposal",
    subjectId: proposal.id,
    meta: { count: candidates.length },
  });
  // rfpOk already sends `cache-control: no-store, private`; the body carries
  // third-party contacts, so that header is load-bearing here.
  return rfpOk({ candidates } satisfies ReferencesGetResponse);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/proposals/[id]/references");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();
  if (proposal.status === "sent") return rfpError("immutable", IMMUTABLE, 409);

  let body: Partial<ReferencesPostBody>;
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  if (!body || typeof body !== "object")
    return rfpError("invalid_request", "Send JSON.", 400);
  if (body.replace !== undefined && typeof body.replace !== "boolean")
    return rfpError(
      "invalid_request",
      "Say whether this edits references already on the section.",
      400
    );
  const replace = body.replace === true;
  if (
    typeof body.label !== "string" ||
    (!replace && typeof body.question !== "string")
  )
    return rfpError(
      "invalid_request",
      "Name the section and the question being answered.",
      400
    );
  const label = body.label;
  // An edit answers no question: the question closed with the first answer.
  const question = replace ? "" : String(body.question).slice(0, 500);
  const submitted = readReferenceEntries(body.references);
  if (!submitted)
    return rfpError(
      "invalid_request",
      "Each reference needs an organization, a contact name and a phone or email.",
      400
    );
  if (typeof body.keep !== "boolean")
    return rfpError(
      "invalid_request",
      "Say whether the contacts should be kept on file.",
      400
    );
  const keep = body.keep;

  const ids = submitted.flatMap((e) => (e.referenceId ? [e.referenceId] : []));
  if (new Set(ids).size !== ids.length)
    return rfpError(
      "invalid_request",
      "The same reference is listed twice.",
      400
    );
  // Two cards for one organization (typed twice, or typed beside its own
  // on-file row) would also save the same row twice; the picker refuses it
  // and so does the API.
  const orgs = submitted.map((e) => e.organization.toLowerCase().replace(/\s+/g, " ").trim());
  if (new Set(orgs).size !== orgs.length)
    return rfpError(
      "invalid_request",
      "The same organization is listed twice.",
      400
    );

  const sections: DraftSectionRecord[] = JSON.parse(
    proposal.sectionsJson || "[]"
  );
  const section = sections.find((s) => s.label === label);
  if (!section) return rfpError("not_found", "No such section.", 404);
  if (replace) {
    if (!holdsReferences(section))
      return rfpError("not_found", NOTHING_TO_EDIT, 404);
  } else {
    if (!section.gaps.some((g) => g.question === question))
      return rfpError(
        "not_found",
        "That question is no longer open on this section.",
        404
      );
    // The canonical question at any count, or a model-worded question asking
    // which client references to list. Any other question takes the gap route.
    if (!(isReferencesGapQuestion(question) || asksAboutReferences(question)))
      return rfpError(
        "invalid_request",
        "That question does not ask for client references. Answer it from the Questions pane.",
        400
      );
  }

  // `referenceId` integrity, before anything is built. The picker sends the
  // id of the row an entry was prefilled from and locks its organization;
  // neither is taken on trust. An id with no LIVE row becomes null (the
  // entry is then a typed-in organization), and a known id takes the row's
  // organization, so the card, `proposal.references` and a kept contact can
  // never sit under a name the row does not carry.
  let entries: ReferenceEntry[] = submitted;
  if (ids.length > 0) {
    let rows: { id: string; organization: string }[];
    try {
      rows = await liveReferenceOrganizations(ids);
    } catch (err) {
      console.error(
        "[rfp] reference id check failed:",
        err instanceof Error ? err.constructor.name : "error"
      );
      return rfpError(
        "unavailable",
        "The references on file could not be checked. Nothing has been changed. Try again.",
        503
      );
    }
    const byId = new Map(rows.map((r) => [r.id, r.organization]));
    entries = submitted.map((e) => {
      if (!e.referenceId) return e;
      const organization = byId.get(e.referenceId);
      if (organization === undefined) return { ...e, referenceId: null };
      // Through the contract's own reader, so what is stored reads back
      // untouched; a row name the contract cannot hold keeps the id and the
      // submitted wording rather than failing the answer.
      return (
        readReferenceEntry({
          ...e,
          organization: organization.slice(0, REFERENCE_LIMITS.organization),
        }) ?? e
      );
    });
  }

  let note: string | null = null;

  // CAS on rev against THE SAME ROW the ownership check ran on. A write that
  // loses the race (an edit or another answer landed in between) recomposes
  // on the fresh state, so the block is never appended to a stale array.
  for (let tries = 0; tries < 3; tries++) {
    const fresh = await getProposalById(proposal.id);
    if (!fresh) return rfpError("conflict", "This draft changed. Reload.", 409);
    if (fresh.status === "sent") return rfpError("immutable", IMMUTABLE, 409);

    const freshSections: DraftSectionRecord[] = JSON.parse(
      fresh.sectionsJson || "[]"
    );
    const at = freshSections.findIndex((s) => s.label === label);
    if (at < 0) return rfpError("conflict", CHANGED, 409);
    const target = freshSections[at];
    if (
      replace
        ? !holdsReferences(target)
        : !target.gaps.some((g) => g.question === question)
    )
      return rfpError("conflict", CHANGED, 409);

    // The record-building is references-answer.ts: THE composer for the
    // intro and the etiquette sentence (exactly once, never a 13th
    // paragraph), the block last (or in the old block's slot on an edit),
    // every references question closed, cites and generatedBy carried except
    // on a section that had no paragraphs (rule A5; see the function).
    const applied = applyReferencesAnswer(
      target,
      referencesOtherText(fresh.title, freshSections, at),
      entries,
      { replace }
    );
    note = applied.trimmed
      ? `A section holds at most ${LIMITS.blocksPerSection} visuals, so the last one on this section was removed to make room for the references.`
      : null;
    // One question, one answer: EVERY question about client references, the
    // canonical one at any count or a model-worded one, closes on every
    // other section too. Their paragraphs are not touched.
    const next = freshSections.map((s, i) =>
      i === at ? applied.section : closeReferencesQuestions(s)
    );

    const ok = await writeProposalSections(
      fresh.id,
      fresh.rev,
      JSON.stringify(next)
    );
    if (!ok) continue;

    // After the document write, never inside the CAS loop: a failure here
    // must not undo the answer. Ids and counts only come back.
    let saved = { kept: 0, created: 0, failed: 0, ids: [] as string[] };
    if (keep) {
      try {
        saved = await saveReferenceContacts(user, entries);
        const lost = entries.length - saved.kept - saved.created;
        if (lost > 0)
          note = [
            note,
            `Contacts for ${lost} of ${entries.length} references could not be kept on file.`,
          ]
            .filter(Boolean)
            .join(" ");
      } catch (err) {
        console.error(
          "[rfp] reference contacts save failed:",
          err instanceof Error ? err.constructor.name : "error"
        );
        note = [
          note,
          "The references are in the proposal, but the contacts could not be kept on file. Try again from Edit references.",
        ]
          .filter(Boolean)
          .join(" ");
      }
    }

    const remaining = next.reduce((n, s) => n + s.gaps.length, 0);
    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: user.admin,
      action: "proposal.references_answer",
      subjectKind: "proposal",
      subjectId: proposal.id,
      meta: {
        section: label,
        count: entries.length,
        keep,
        kept: saved.kept,
        created: saved.created,
        remaining,
        ...(replace ? { replace: true } : {}),
      },
    });
    if (keep && saved.kept + saved.created > 0)
      await logRfpActivity({
        actorEmail: user.email,
        actorAdmin: user.admin,
        action: "reference.contacts_save",
        subjectKind: "proposal",
        subjectId: proposal.id,
        meta: { ids: saved.ids.join(",") },
      });

    return rfpOk({
      sections: next,
      rev: fresh.rev + 1,
      kept: saved.kept,
      created: saved.created,
      ...(note ? { note } : {}),
    });
  }

  return rfpError("conflict", CHANGED, 409);
}
