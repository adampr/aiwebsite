// POST - bring an on-file Builder snapshot back into the Governance Builder
// (§5.18 edit-again, owner directive 2026-08-20: "Even final governance
// should be editable in the future"). Within a project's 30-day life the
// builder's own reopen already covers edits; this route closes the gap
// AFTER retention deletes the source project, when the company file's
// snapshot was the only surviving copy. Two outcomes:
//  - the caller still OWNS a live project with the row's
//    governance_project_id: answer { projectId, created: false } and write
//    nothing (the workspace offers Reopen there if it is done);
//  - otherwise SEED a new project from the snapshot markdown
//    (parseSnapshotMarkdown, the projectMarkdown inverse), owned by the
//    CALLER, directly in `review` where every edit tool is already legal,
//    then RE-KEY the doc row's governance_project_id to the new project so
//    the §5.12 confirm-final auto-attach REFRESHES this exact row instead
//    of inserting a duplicate (last editor wins the refresh key; a
//    colleague's still-live original inserts a fresh row on its next
//    confirm - accepted, mirrors the no-unique-constraint acceptance).
// Lane/auth mirrors the attach lane exactly (the docs-gate "attach" gate:
// member-actionable on the company lane, global-admin on the XL.net staff
// lane); the doc id comes from the URL, the lane ALWAYS from the session,
// and missing/not-owned/wrong-source are one identical 404 (no existence
// oracle). The seed costs zero AI calls but IS a new project row, so it
// spends the builder's per-person creates/day budget and respects the
// active-projects cap exactly like the create route; the roadmap:docs
// write token is spent only after EVERY validation passes (the 2026-08-09
// lockout mechanic: a refused attempt must not burn the fixed-window
// token). Gated on governanceEnabled like reopen - seeding into a
// workbench where every tool 503s would be a trap.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  CAPS,
  governanceEnabled,
  normalizeDomain,
  REVIEW_IMPORTED_SUMMARY,
  withOpenItemsNote,
} from "@/lib/governance/config";
import { openConfirmTotal } from "@/lib/governance/view";
import {
  effectiveCreatesPerUserPerDay,
  isBudgetExemptEmail,
  notifyBudgetHit,
} from "@/lib/governance/budget";
import {
  countActiveProjects,
  countCreatedToday,
  createImportedProject,
  fetchOwnedProject,
} from "@/lib/governance/db";
import {
  importedTranscriptEntry,
  parseSnapshotMarkdown,
} from "@/lib/governance/snapshot";
import { isGovernanceKind } from "@/lib/governance/types";
import { docsWriteLane } from "@/lib/roadmap/docs-gate";
import {
  governanceDocForEdit,
  repointGovernanceDocProject,
} from "@/lib/roadmap/db";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () =>
  roadmapError("not_found", "That document does not exist.", 404);

export async function POST(_req: Request, ctx: Ctx): Promise<Response> {
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;
  const lane = await docsWriteLane("attach");
  if (!lane.ok) return lane.response;
  if (!governanceEnabled(process.env))
    return roadmapError(
      "feature_disabled",
      "The Governance Builder is paused right now. The document stays on file and downloads still work; try again later.",
      503
    );
  // Cheap per-minute request throttle (the create route's shape), NOT the
  // fixed-hour docs token - that is spent only after validation below.
  const limited = rateLimit(`roadmap:docedit:${lane.userId}`, 60, 10);
  if (limited) return limited;

  const { id } = await ctx.params;
  const doc = await governanceDocForEdit(id, lane.scope);
  if (!doc || doc.source !== "governance_project" || !doc.docText)
    return NOT_FOUND();

  // Still-live source project owned by the caller: nothing to seed, the
  // builder's reopen lane takes it from here.
  if (doc.governanceProjectId) {
    const live = await fetchOwnedProject(lane.userId, doc.governanceProjectId);
    if (live) return okJson({ projectId: live.id, created: false });
  }

  // NULL/unknown governance_kind is INELIGIBLE, answered with the same 404
  // as missing and wrong-source (oracle-safe). Snapshot rows always store
  // project.kind by construction, so this guards malformed/legacy rows
  // only; a fallback kind would parse the snapshot against the wrong
  // blueprint allowlist (a 7-doc FFIEC file folded into one doc).
  if (!isGovernanceKind(doc.governanceKind)) return NOT_FOUND();
  const kind = doc.governanceKind;
  const documents = parseSnapshotMarkdown(doc.docText, kind);
  if (!documents.length)
    return roadmapError(
      "unreadable",
      "We could not read that document back into the Builder. It stays on file, and downloads still work.",
      409
    );

  // Builder caps + per-person budget, exactly the create route's checks
  // (and its copy). All of this is VALIDATION - before any token spend.
  if ((await countActiveProjects(lane.userId)) >= CAPS.activeProjectsPerUser)
    return roadmapError(
      "project_cap",
      `You can have ${CAPS.activeProjectsPerUser} projects in progress at once. Finish or delete one first.`,
      409
    );
  const createsCap = await effectiveCreatesPerUserPerDay();
  if (
    !isBudgetExemptEmail(lane.email) &&
    (await countCreatedToday(lane.userId)) >= createsCap
  ) {
    void notifyBudgetHit("person_creates", {
      who: lane.email,
      operation: "edit on-file document",
    });
    return roadmapError(
      "create_cap",
      "You have hit the limit for new projects today. It resets at midnight UTC. Your existing projects are unaffected.",
      429
    );
  }
  // The lane's verified tenancy domain, never a request field (company
  // domain / STAFF_LANE_DOMAIN); email-domain fallback for safety only.
  const domain =
    normalizeDomain(lane.internalDomain) ??
    normalizeDomain(lane.email.split("@")[1] ?? "");
  if (!domain)
    return roadmapError(
      "invalid_request",
      "We could not resolve a company domain for this workspace.",
      409
    );
  const transcript = [importedTranscriptEntry(new Date().toISOString())];
  // Pre-spend size check (createImportedProject re-enforces it): an
  // oversized refusal must not burn the write token either.
  if (
    Buffer.byteLength(JSON.stringify(documents)) > CAPS.documentsJsonMaxBytes
  )
    return roadmapError(
      "too_large",
      "That document is too large to bring back into the Builder.",
      413
    );

  // Every validation passed: NOW spend the docs write token.
  const writeLimited = rateLimit(
    `roadmap:docs:${lane.userId}`,
    3600,
    ROADMAP_CAPS.docWritesPerUserPerHour
  );
  if (writeLimited) return writeLimited;

  const projectId = await createImportedProject({
    userId: lane.userId,
    kind,
    domain,
    documents,
    transcript,
    // Owner rule 2026-07-17: a review summary must never read as
    // ready-for-final while [TO CONFIRM] markers remain - and a snapshot
    // CAN carry them (the manual attach lane has no marker gate).
    reviewSummary: withOpenItemsNote(
      REVIEW_IMPORTED_SUMMARY,
      openConfirmTotal(documents)
    ),
  });
  if (!projectId)
    return roadmapError(
      "too_large",
      "That document is too large to bring back into the Builder.",
      413
    );
  // Re-key the snapshot row so the new project's confirm-final refreshes
  // it in place. Lane-scoped like every doc write; a lost race with a
  // concurrent remove leaves a normal orphaned project (30-day cleanup).
  await repointGovernanceDocProject({
    docId: id,
    scope: lane.scope,
    governanceProjectId: projectId,
  });
  return okJson({ projectId, created: true }, 201);
}
