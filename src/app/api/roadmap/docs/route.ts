// POST - put a governance document on file for the company (§5.18 step 1).
// Two lanes:
//  - multipart upload (pdf/docx/md/txt, ~10 MB route cap): company-admin
//    only; the original bytes are stored (downloads serve them back as
//    octet-stream).
//  - JSON { governanceProjectId }: attach a SNAPSHOT of the caller's OWN
//    Governance Builder project (listOwnedProjects ownership; a colleague's
//    projects are theirs to attach) - member-actionable, mirroring the
//    member-actionable submit lane. The snapshot copies the rendered
//    markdown at attach time; the source project keeps its 30-day lifecycle
//    untouched (this is the whole scope of the no-ledger reversal).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { requireCompanyAdmin, requireCompanyMember } from "@/lib/roadmap/access";
import { addGovernanceDoc } from "@/lib/roadmap/db";
import { fetchOwnedProject } from "@/lib/governance/db";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
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

type ProjectDoc = {
  title?: unknown;
  sections?: { title?: unknown; markdown?: unknown }[];
};

/** Lenient flatten of a project's documents_json to markdown. Placeholder
 * and malformed sections degrade to their headings; the snapshot is a copy
 * for the company file, not a re-render. */
function projectMarkdown(documentsJson: string): string {
  let docs: ProjectDoc[] = [];
  try {
    const parsed = JSON.parse(documentsJson);
    if (Array.isArray(parsed)) docs = parsed as ProjectDoc[];
  } catch {
    docs = [];
  }
  const out: string[] = [];
  for (const doc of docs) {
    if (typeof doc?.title === "string") out.push(`# ${doc.title}`);
    for (const s of Array.isArray(doc?.sections) ? doc.sections : []) {
      if (typeof s?.title === "string") out.push(`\n## ${s.title}\n`);
      if (typeof s?.markdown === "string") out.push(s.markdown);
    }
    out.push("\n\n---\n");
  }
  return out.join("\n").trim();
}

export async function POST(req: Request): Promise<Response> {
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    // Attach-own-project lane: member-actionable.
    const gate = await requireCompanyMember();
    if (!gate.ok) return gate.response;
    const p = gate.principal;
    const limited = rateLimit(
      `roadmap:docs:${p.userId}`,
      3600,
      ROADMAP_CAPS.docWritesPerUserPerHour
    );
    if (limited) return limited;
    let projectId = "";
    try {
      const body = (await req.json()) as { governanceProjectId?: unknown };
      projectId =
        typeof body.governanceProjectId === "string"
          ? body.governanceProjectId
          : "";
    } catch {
      projectId = "";
    }
    const project = await fetchOwnedProject(p.userId, projectId);
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
    const id = await addGovernanceDoc({
      companyId: p.company.id,
      source: "governance_project",
      title,
      docText: markdown,
      governanceProjectId: project.id,
      governanceKind: project.kind,
      addedByUserId: p.userId,
      addedByEmail: p.email,
    });
    return okJson({ id, title }, 201);
  }

  // Upload lane: company-admin only.
  const gate = await requireCompanyAdmin();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const limited = rateLimit(
    `roadmap:docs:${p.userId}`,
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
    companyId: p.company.id,
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
    addedByUserId: p.userId,
    addedByEmail: p.email,
  });
  return okJson({ id, title }, 201);
}
