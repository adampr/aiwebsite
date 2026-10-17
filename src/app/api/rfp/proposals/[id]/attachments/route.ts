// /api/rfp/proposals/[id]/attachments (ARCHITECTURE.md §5.17.23, round 35)
//
// GET  the proposal's picks: ProposalAttachmentsResponse
//      {rev, picks: [{docId, n, title, confidentialConfirmed?: {by, at}}],
//       map: {"<requirementId>": n | 0 | {ns: [n...], section?: "<label>"}},
//       docs: {"<docId>": LibraryDocumentWire}, pickedAt?: ISO}
//      (attachments.ts readProposalAttachments: null and garbage read as no
//      picks; `docs` carries each picked document's library row, retired
//      ones flagged, never bytes).
// POST one of two bodies, each answered with the fresh GET shape:
//   {op: "set", picks: [docId, ...], confirm?: [docId, ...]}
//      the WHOLE pick list in its new order (attachments.ts planSetPicks):
//      every id at most once; a NEW pick must name a live library row (404),
//      an id already picked stays even if its row has since retired; a
//      confidential document needs a confirmation, recorded with its pick
//      as {by: the session's email, at: now} when `confirm` names it, else
//      409 {error: "confidential_unconfirmed"} with a message naming the
//      document's TITLE; picks renumber 1..k densely and every mapping
//      follows its document to its new number. When the pick list changes,
//      pickedAt is stamped, and every {{att:N}} citation stored in the
//      proposal's sections (paragraphs, answers, every block string, the
//      letter) is renumbered IN THE SAME fenced UPDATE (round 35 fix T2,
//      attachments.ts remapSectionsAttTokens): old n -> new n, a removed
//      pick's -> {{att:0}}, which strips. The response's `retargeted` is how
//      many citations moved (the workspace then re-reads the sections).
//   {op: "map", map: {"<requirementId>": n | 0 | {ns, section?} | null}}
//      MERGED into the stored mapping (attachments.ts planSetMap): every key
//      a requirement of this proposal's RFP, every value a picked n, 0 ("Not
//      included"), {ns: [picked n...], section?: a structure label of this
//      RFP} or null (unmapped again); else 400 and nothing changes.
// Both write attachments_json under CAS on rev (re-read and re-planned up to
// three times when another write lands first, then 409); a sent proposal is
// never edited (409 "immutable"). Activity `proposal.attachments`: counts
// only, never a title.

import { logRfpActivity } from "@/lib/rfp/activity";
import {
  libraryWire,
  planSetMap,
  planSetPicks,
  readProposalAttachments,
  remapSectionsAttTokens,
  serializeProposalAttachments,
  type ProposalAttachments,
  type ProposalAttachmentsResponse,
} from "@/lib/rfp/attachments";
import {
  getDocument,
  getOwnedProposal,
  getProposalById,
  libraryDocumentsByIds,
  listLibraryDocuments,
  listRequirements,
  writeProposalAttachments,
} from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const IMMUTABLE = "A sent proposal is never edited. A correction creates a new one.";
const CHANGED = "This draft changed while the attachments were being saved. Reload to see it.";

async function responseFor(rev: number, state: ProposalAttachments): Promise<ProposalAttachmentsResponse> {
  const rows = await libraryDocumentsByIds(state.picks.map((p) => p.docId));
  const docs: ProposalAttachmentsResponse["docs"] = {};
  for (const r of rows) docs[r.id] = libraryWire(r);
  return { rev, picks: state.picks, map: state.map, docs, ...(state.pickedAt ? { pickedAt: state.pickedAt } : {}) };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("GET /api/rfp/proposals/[id]/attachments");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const proposal = await getOwnedProposal(gate.user, id);
  if (!proposal) return notFound();
  try {
    return rfpOk(await responseFor(proposal.rev, readProposalAttachments(proposal.attachmentsJson)));
  } catch (err) {
    console.error("[rfp] attachments read failed:", err instanceof Error ? err.constructor.name : "error");
    return rfpError("unavailable", "The attachments could not be read. Try again.", 503);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/proposals/[id]/attachments");
  if (!gate.ok) return gate.response;
  const user = gate.user;
  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();
  if (proposal.status === "sent") return rfpError("immutable", IMMUTABLE, 409);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const op = body.op;
  if (op !== "set" && op !== "map")
    return rfpError("invalid_request", 'Send {"op": "set"} with the picks, or {"op": "map"} with the mapping.', 400);

  // What the plan reads besides the row: the library (set) or the RFP's
  // requirement ids (map). Read once; the CAS loop re-reads only the row.
  let library: Awaited<ReturnType<typeof listLibraryDocuments>> = [];
  let requirementIds: string[] = [];
  let sectionLabels: string[] = [];
  try {
    if (op === "set") {
      const live = await listLibraryDocuments();
      const current = readProposalAttachments(proposal.attachmentsJson);
      // Rows already picked stay resolvable even when retired since.
      const held = await libraryDocumentsByIds(current.picks.map((p) => p.docId));
      const seen = new Set(live.map((d) => d.id));
      library = [...live, ...held.filter((d) => !seen.has(d.id))];
    } else {
      requirementIds = (await listRequirements(proposal.documentId)).map((r) => r.id);
      // The sections a request may be answered in: this RFP's structure.
      const doc = await getDocument(user, proposal.documentId);
      try {
        const structure: unknown = JSON.parse(doc?.structureJson || "[]");
        sectionLabels = Array.isArray(structure)
          ? structure.flatMap((n) =>
              n && typeof n === "object" && typeof (n as { label?: unknown }).label === "string"
                ? [(n as { label: string }).label]
                : []
            )
          : [];
      } catch {
        sectionLabels = [];
      }
    }
  } catch (err) {
    console.error("[rfp] attachments lookup failed:", err instanceof Error ? err.constructor.name : "error");
    return rfpError("unavailable", "The library could not be checked. Nothing has been changed. Try again.", 503);
  }

  for (let tries = 0; tries < 3; tries++) {
    const fresh = tries === 0 ? proposal : await getProposalById(proposal.id);
    if (!fresh) return rfpError("conflict", CHANGED, 409);
    if (fresh.status === "sent") return rfpError("immutable", IMMUTABLE, 409);
    const current = readProposalAttachments(fresh.attachmentsJson);

    let state: ProposalAttachments;
    let meta: Record<string, number | string>;
    // The citation remap the same write carries (set only, T2).
    let remapped: { json: string; changed: number } | null = null;
    if (op === "set") {
      const plan = planSetPicks({
        current,
        docIds: body.picks,
        confirm: body.confirm,
        library,
        actor: user.email.toLowerCase(),
        now: new Date().toISOString(),
      });
      if (!plan.ok) return rfpError(plan.code, plan.message, plan.status);
      state = plan.state;
      remapped = plan.changed ? remapSectionsAttTokens(fresh.sectionsJson, plan.renumber) : null;
      meta = {
        op: "set",
        picks: state.picks.length,
        added: plan.added,
        removed: plan.removed,
        confirmed: plan.confirmed,
        confidential: state.picks.filter((p) => p.confidentialConfirmed).length,
        retargeted: remapped?.changed ?? 0,
      };
    } else {
      const plan = planSetMap({ current, map: body.map, requirementIds, sectionLabels });
      if (!plan.ok) return rfpError(plan.code, plan.message, plan.status);
      state = plan.state;
      meta = { op: "map", picks: state.picks.length, mapped: plan.mapped, notIncluded: plan.notIncluded };
    }

    const json = serializeProposalAttachments(state);
    const noop = json === fresh.attachmentsJson && remapped === null;
    const ok = noop
      ? true // nothing to write: no rev bump for a no-op
      : await writeProposalAttachments(fresh.id, fresh.rev, json, remapped?.json);
    if (!ok) continue;
    const rev = noop ? fresh.rev : fresh.rev + 1;
    const retargeted = remapped?.changed ?? 0;

    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: user.admin,
      action: "proposal.attachments",
      subjectKind: "proposal",
      subjectId: proposal.id,
      meta,
    });
    try {
      return rfpOk({ ...(await responseFor(rev, readProposalAttachments(json))), ...(retargeted ? { retargeted } : {}) });
    } catch {
      // The write landed; only the details read failed.
      const parsed = readProposalAttachments(json);
      return rfpOk({
        rev,
        picks: parsed.picks,
        map: parsed.map,
        docs: {},
        ...(parsed.pickedAt ? { pickedAt: parsed.pickedAt } : {}),
        ...(retargeted ? { retargeted } : {}),
      } satisfies ProposalAttachmentsResponse);
    }
  }
  return rfpError("conflict", CHANGED, 409);
}
