// GET — word-friendly downloads (§5.12): ?format=docx&doc=<slug> for one
// document, ?format=zip for the whole set + README. Generated on demand from
// stored markdown, streamed, never stored; ZERO AI calls, so downloads work
// through every outage, budget cap, and the feature kill switch. Touches
// last_activity_at (a download proves continued interest; the UI discloses
// that the auto-delete date moves).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { fileSlug } from "@/lib/governance/config";
import { fetchOwnedProject, touchActivity } from "@/lib/governance/db";
import { renderDocx, renderZip } from "@/lib/governance/docx";
import { govError, NOT_FOUND, rateLimit, requireUser } from "@/lib/governance/http";
import type {
  GovernanceDoc,
  GovernanceKind,
  TranscriptEntry,
} from "@/lib/governance/types";
import { openConfirmItems } from "@/lib/governance/view";

type Ctx = { params: Promise<{ id: string }> };

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const limited = rateLimit(`gov:download:${user.userId}`, 600, 10);
  if (limited) return limited;

  const row = await fetchOwnedProject(user.userId, id);
  if (!row) return NOT_FOUND();

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "docx";
  const docs = parse<GovernanceDoc[]>(row.documentsJson, []);
  if (!docs.length)
    return govError("invalid_request", "Nothing to download yet.", 409);
  const draft = row.status !== "done";
  const suffix = draft ? "-draft" : "";
  const domainSlug = fileSlug(row.domain, "company");

  try {
    if (format === "zip") {
      const transcript = parse<TranscriptEntry[]>(row.transcriptJson, []);
      const buf = await renderZip({
        kind: row.kind as GovernanceKind,
        domain: row.domain,
        draft,
        docs,
        reviewSummary: row.reviewSummary,
        openConfirmCount: openConfirmItems(docs).length,
        skippedCount: transcript.filter((t) => t.skipped).length,
      });
      await touchActivity(row.id);
      return new Response(new Uint8Array(buf), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${domainSlug}-${fileSlug(row.kind)}${suffix}.zip"`,
          "cache-control": "no-store, private",
        },
      });
    }
    const slug = url.searchParams.get("doc") ?? docs[0].slug;
    const doc = docs.find((d) => d.slug === slug);
    if (!doc) return NOT_FOUND();
    const buf = await renderDocx(doc, {
      draft,
      kind: row.kind as GovernanceKind,
    });
    await touchActivity(row.id);
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename="${domainSlug}-${fileSlug(doc.slug)}${suffix}.docx"`,
        "cache-control": "no-store, private",
      },
    });
  } catch {
    return govError(
      "invalid_request",
      "That file could not be generated. Try a single-document download.",
      500
    );
  }
}
