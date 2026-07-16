// POST — keep one open [TO CONFIRM] item as drafted (§5.12). The user's
// explicit "the drafted default is correct" strips exactly that marker from
// the stored markdown, deterministically, with ZERO AI calls: it works
// through brain outages and budget caps, which is the point (the typed-fact
// path needs a revise turn; this path must never be hostage to one).
// Refuses when the strip would leave the containing block empty (the marker
// IS the content there; only a typed answer resolves it). The decision is
// recorded in the transcript: keep-as-drafted is a user answer, and the
// audit trail must show who resolved each assumption.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { placeholderSectionMap } from "@/lib/governance/blueprints";
import { CAPS, governanceEnabled } from "@/lib/governance/config";
import { applyResolveWrite, fetchOwnedProject } from "@/lib/governance/db";
import { govError, NOT_FOUND, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import { stripConfirmMarker } from "@/lib/governance/markdown";
import { progressFor } from "@/lib/governance/turn";
import { openConfirmItems, openConfirmTotal } from "@/lib/governance/view";
import type {
  GovernanceDoc,
  GovernanceKind,
  TranscriptEntry,
} from "@/lib/governance/types";

type Ctx = { params: Promise<{ id: string }> };

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  if (!governanceEnabled(process.env))
    return govError(
      "feature_disabled",
      "New drafting is paused right now. Existing projects and downloads still work.",
      503
    );
  const { id } = await ctx.params;
  // Generous bucket: keeps are free (no AI) and users sweep them rapidly.
  const limited = rateLimit(`gov:resolve:${user.userId}`, 60, 30);
  if (limited) return limited;

  let body: {
    doc?: unknown;
    section?: unknown;
    excerpt?: unknown;
    occurrence?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return govError("invalid_request", "Bad JSON body.", 400);
  }
  const docSlug = typeof body.doc === "string" ? body.doc.slice(0, 64) : "";
  const sectionId =
    typeof body.section === "string" ? body.section.slice(0, 64) : "";
  const excerpt =
    typeof body.excerpt === "string" ? body.excerpt.slice(0, 200) : "";
  const occurrence =
    typeof body.occurrence === "number" &&
    Number.isInteger(body.occurrence) &&
    body.occurrence >= 0 &&
    body.occurrence < 1000
      ? body.occurrence
      : 0;
  if (!docSlug || !sectionId || !excerpt)
    return govError("invalid_request", "doc, section, and excerpt required.", 400);

  const row = await fetchOwnedProject(user.userId, id);
  if (!row) return NOT_FOUND();
  if (row.status !== "review")
    return govError(
      "invalid_request",
      "Open items are resolved during review.",
      409
    );
  // A fresh revise-turn claim owns the row: a strip that bumped rev under
  // the worker would void its final write and waste the brain call. The
  // applyResolveWrite fence backstops this atomically; the pre-check just
  // names the situation honestly.
  if (
    row.turnStartedAt &&
    Date.now() - row.turnStartedAt.getTime() < CAPS.turnStaleMs
  )
    return govError(
      "turn_pending",
      "Tron is folding answers into the draft right now. Give it a moment; the list refreshes when he is done.",
      409
    );

  const kind = row.kind as GovernanceKind;
  const documents = parse<GovernanceDoc[]>(row.documentsJson, []);
  const doc = documents.find((d) => d.slug === docSlug);
  const section = doc?.sections.find((s) => s.id === sectionId);
  if (!doc || !section)
    return govError(
      "item_not_found",
      "That item was already resolved, maybe in another tab.",
      409
    );

  const stripped = stripConfirmMarker(section.markdown, excerpt, occurrence);
  if (!stripped.ok) {
    if (stripped.reason === "needs_answer")
      return govError(
        "needs_answer",
        "This one needs an answer from you: the marker is the only content there, so there is no drafted default to keep.",
        409
      );
    return govError(
      "item_not_found",
      "That item was already resolved, maybe in another tab.",
      409
    );
  }

  const newDocuments = documents.map((d) =>
    d.slug !== docSlug
      ? d
      : {
          ...d,
          sections: d.sections.map((s) =>
            s.id !== sectionId ? s : { ...s, markdown: stripped.markdown }
          ),
        }
  );
  const now = new Date().toISOString();
  const transcript: TranscriptEntry[] = [
    ...parse<TranscriptEntry[]>(row.transcriptJson, []),
    {
      qId: "confirm",
      bankId: null,
      q: `Open item: ${excerpt.slice(0, 160)}`,
      a: "Kept as drafted.",
      skipped: false,
      askedAt: now,
      answeredAt: now,
    },
  ];
  const changedSections = { [docSlug]: [sectionId] };
  const covered = parse<string[]>(row.coveredBankIdsJson, []);

  const wrote = await applyResolveWrite({
    id: row.id,
    userId: user.userId,
    expectedRev: row.rev,
    documents: newDocuments,
    transcript,
    changedSections,
  });
  if (!wrote)
    return govError(
      "item_not_found",
      "The draft changed in another tab. The list refreshes with where it is now.",
      409
    );

  return okJson({
    rev: row.rev + 1,
    status: "review",
    changedSections,
    placeholderSections: placeholderSectionMap(kind, newDocuments),
    nextQuestion: null,
    reviewSummary: row.reviewSummary,
    progress: progressFor(kind, new Set(covered)),
    openConfirmItems: openConfirmItems(newDocuments),
    openConfirmTotal: openConfirmTotal(newDocuments),
    documents: newDocuments,
  });
}
