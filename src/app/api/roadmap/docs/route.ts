// POST - put a governance document on file (§5.18 step 1). Three content
// lanes:
//  - multipart upload (pdf/docx/md/txt, ~10 MB route cap): admin only; the
//    original bytes are stored (downloads serve them back as octet-stream).
//  - JSON { governanceProjectId }: attach a SNAPSHOT of the caller's OWN
//    Governance Builder project (listOwnedProjects ownership; a colleague's
//    projects are theirs to attach) - member-actionable on the COMPANY
//    lane, mirroring the member-actionable submit lane. The snapshot copies
//    the rendered markdown at attach time; the source project keeps its
//    30-day lifecycle untouched (this is the whole scope of the no-ledger
//    reversal). Re-attaching the same project REFRESHES the lane's existing
//    snapshot row in place (attachOrRefreshGovernanceDoc: title, text,
//    added-by, stamp; 200 with the existing id, 201 only on first attach) -
//    the builder's confirm-final auto-attach (§5.12, owner directive
//    2026-08-20) lands here on every reopen -> confirm cycle by design, and
//    duplicates would pile up otherwise. This deliberately changes manual
//    re-attach from "second row" to "refresh" as well.
//  - JSON { url, title? }: link an existing policy where it already lives
//    (owner directive 2026-08-18). Admin-gated like upload. The URL goes
//    through parseCheckableUrl (the scheme gate: the stored href becomes an
//    anchor, so this is the XSS gate too) and checkUrlReachable (§5.20
//    SSRF-pinned checker; content is never read). A SECURED page counts:
//    statusCounts accepts 401/403 - the owner asked only that the link
//    "goes to SOME page", and a policy behind a sign-in wall is exactly the
//    expected case. Reachability spends the SHARED roadmap:urlcheck:*
//    buckets on top of the doc-write bucket: the caps bound our total
//    outbound probe traffic, so a second spelling would double them.
// Tenancy lane (staff governance round): docsWriteLane resolves the XL.net
// staff lane (global-admin only for ALL content lanes) or the caller's
// company; the scope it returns is bound into every db call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { docsWriteLane, type DocsLane } from "@/lib/roadmap/docs-gate";
import {
  addGovernanceDoc,
  attachOrRefreshGovernanceDoc,
} from "@/lib/roadmap/db";
import { fetchOwnedProject } from "@/lib/governance/db";
import { projectMarkdown } from "@/lib/governance/snapshot";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import { checkUrlReachable, parseCheckableUrl } from "@/lib/roadmap/url-check";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

const KIND_TITLES: Record<string, string> = {
  usage_policy: "AI Acceptable Use Policy (AUP)",
  nist_ai_rmf: "NIST AI RMF Alignment",
  eu_ai_act: "EU AI Act Readiness",
  iso_42001: "ISO 42001 Alignment",
};

// projectMarkdown moved to @/lib/governance/snapshot (2026-08-20 edit-again
// round): it now has an inverse (parseSnapshotMarkdown, the [id]/edit seed)
// and the pair must live together so they cannot drift.

/** Reason -> copy for a refused link (platform-copy failureLine wording,
 * minus the parts that do not exist here: nothing is saved on failure and
 * there is no attest rung, so no "confirm it below"). Same discipline: say
 * what happened, stay incurious about WHY at the network layer. */
function linkRefusalMessage(
  reason: string,
  httpStatus: number | null
): string {
  switch (reason) {
    case "not_public":
      return "That address is not reachable from the public internet, so your team could not open it either. Use the address they would actually click, or one inside your own domain if the policy lives on your network.";
    case "http_status":
      return httpStatus
        ? `A server answered with ${httpStatus}, so the address itself is wrong or the page is broken. Fix the link and try again.`
        : "A server answered, but not in a way we could confirm. Check the link and try again.";
    case "self_host":
      return "That address points back at this site. Link the policy where it actually lives.";
    case "redirect_loop":
      return "That address redirected too many times for us to follow. Link the policy's address directly.";
    default:
      // "unreachable" and anything future: ONE bucket by design (url-check
      // header: distinguishing refused from no-DNS is a port scanner).
      return "We could not reach that address. It may be offline, blocking us, or on a network we cannot see. Check the link and try again.";
  }
}

/** The link lane's reachability budget: the SHARED §5.20 urlcheck buckets
 * (per-user + per-lane), exactly the platform-http keys - these caps bound
 * total outbound probe traffic, so the doc lane must draw the same fence
 * rather than minting a parallel one. */
function limitDocLinkCheck(lane: DocsLane & { ok: true }): Response | null {
  const perUser = rateLimit(
    `roadmap:urlcheck:${lane.userId}`,
    3600,
    ROADMAP_CAPS.urlChecksPerUserPerHour
  );
  if (perUser) return perUser;
  return rateLimit(
    `roadmap:urlcheck:lane:${lane.laneKey}`,
    3600,
    ROADMAP_CAPS.urlChecksPerCompanyPerHour
  );
}

export async function POST(req: Request): Promise<Response> {
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    // The body picks the JSON lane (link vs attach), so it is read BEFORE
    // the gate - lane selection needs it, and parsing grants nothing.
    let body: {
      governanceProjectId?: unknown;
      url?: unknown;
      title?: unknown;
    } = {};
    try {
      // ?? {}: req.json() RESOLVES (not throws) on the literal body `null`,
      // and this runs pre-auth, so without it `null` is an anonymous 500.
      body = ((await req.json()) ?? {}) as typeof body;
    } catch {
      body = {};
    }

    if (typeof body.url === "string") {
      // Link lane: admin-gated in BOTH lanes, mirroring upload (members
      // attach their OWN work; pointing the company file at an arbitrary
      // external address is an admin act, like filing the binary).
      const lane = await docsWriteLane("admin");
      if (!lane.ok) return lane.response;
      // Scheme gate FIRST (free, and a refused parse must not spend an
      // outbound-probe token). parsed.href is the ONLY value that may reach
      // the database: it is what the on-file page renders as an anchor.
      const parsed = parseCheckableUrl(body.url);
      if (!parsed)
        return roadmapError(
          "invalid_request",
          "We could not read that as a web address. Use a full http or https address, up to 500 characters, with no username or password in it.",
          400
        );
      const spent = limitDocLinkCheck(lane);
      if (spent) return spent;
      // The check confirms a server ANSWERS, nothing more (statusCounts
      // accepts 401/403: a policy behind a sign-in wall is the expected
      // case, per the owner's "goes to SOME page"). Rung 2 ("internal")
      // also passes: a host inside the lane's verified domain resolving
      // into private space is a coherent place for a company policy, and
      // we never connect to it.
      const outcome = await checkUrlReachable(parsed.href, {
        internalDomain: lane.internalDomain,
      });
      if (!outcome.ok)
        return roadmapError(
          "url_check_failed",
          linkRefusalMessage(outcome.reason, outcome.status),
          409
        );
      // The docs WRITE token is spent only once the check passes: a flaky
      // target must never lock the admin out of upload/link/remove for the
      // rest of the limiter's fixed hour (the 2026-08-09 directory-lockout
      // mechanic); refused attempts burn only the urlcheck buckets above.
      const limited = rateLimit(
        `roadmap:docs:${lane.userId}`,
        3600,
        ROADMAP_CAPS.docWritesPerUserPerHour
      );
      if (limited) return limited;
      const title =
        (typeof body.title === "string" ? body.title : "")
          .trim()
          .slice(0, ROADMAP_CAPS.docTitleMaxChars) || parsed.url.hostname;
      const id = await addGovernanceDoc({
        scope: lane.scope,
        source: "link",
        title,
        linkUrl: parsed.href,
        docText: null,
        addedByUserId: lane.userId,
        addedByEmail: lane.email,
      });
      return okJson({ id, title }, 201);
    }

    // Attach-own-project lane: member-actionable (company); global-admin
    // (staff).
    const lane = await docsWriteLane("attach");
    if (!lane.ok) return lane.response;
    const limited = rateLimit(
      `roadmap:docs:${lane.userId}`,
      3600,
      ROADMAP_CAPS.docWritesPerUserPerHour
    );
    if (limited) return limited;
    const projectId =
      typeof body.governanceProjectId === "string"
        ? body.governanceProjectId
        : "";
    const project = await fetchOwnedProject(lane.userId, projectId);
    if (!project)
      return roadmapError(
        "not_found",
        "That Governance Builder project was not found among your own projects. Projects delete 30 days after their last activity.",
        404
      );
    const markdown = projectMarkdown(project.documentsJson);
    if (!markdown)
      return roadmapError(
        "empty_project",
        "That project has no drafted documents yet. Draft it in the Governance Builder first.",
        409
      );
    const title = KIND_TITLES[project.kind] ?? "AI Governance Document";
    const { id, refreshed } = await attachOrRefreshGovernanceDoc({
      scope: lane.scope,
      title,
      docText: markdown,
      governanceProjectId: project.id,
      governanceKind: project.kind,
      addedByUserId: lane.userId,
      addedByEmail: lane.email,
    });
    return okJson({ id, title, refreshed }, refreshed ? 200 : 201);
  }

  // Upload lane: company-admin (company) / global-admin (staff) only.
  const lane = await docsWriteLane("admin");
  if (!lane.ok) return lane.response;
  const limited = rateLimit(
    `roadmap:docs:${lane.userId}`,
    3600,
    ROADMAP_CAPS.docWritesPerUserPerHour
  );
  if (limited) return limited;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return roadmapError(
      "invalid_request",
      "Send the document as multipart form data.",
      400
    );
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return roadmapError("invalid_request", "Attach the document file.", 400);
  if (file.size > ROADMAP_CAPS.docUploadMaxBytes)
    return roadmapError(
      "invalid_request",
      `That file is too large (limit ${Math.floor(ROADMAP_CAPS.docUploadMaxBytes / 1_000_000)} MB).`,
      400
    );
  const name = (file.name || "document").slice(0, 200);
  if (!/\.(pdf|docx?|md|markdown|txt)$/i.test(name))
    return roadmapError(
      "invalid_request",
      "Upload a .pdf, .docx, .md, or .txt document.",
      400
    );
  const title =
    String(form.get("title") ?? "")
      .trim()
      .slice(0, ROADMAP_CAPS.docTitleMaxChars) || name.replace(/\.[^.]+$/, "");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0 || bytes.length > ROADMAP_CAPS.docUploadMaxBytes)
    return roadmapError("invalid_request", "That file is too large.", 400);
  const id = await addGovernanceDoc({
    scope: lane.scope,
    source: "upload",
    title,
    file: {
      name,
      mime: (file.type || "application/octet-stream").slice(0, 100),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      data: bytes,
    },
    docText: null,
    addedByUserId: lane.userId,
    addedByEmail: lane.email,
  });
  return okJson({ id, title }, 201);
}
