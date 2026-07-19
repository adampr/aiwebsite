// POST — keep one open [TO CONFIRM] item as drafted (§5.12). The user's
// explicit "the drafted default is correct" strips exactly that marker from
// the stored markdown, deterministically, with ZERO AI calls: it works
// through brain outages and budget caps, which is the point (the typed-fact
// path needs a revise turn; this path must never be hostage to one).
// Refuses when the strip would leave the containing block empty (the marker
// IS the content there; only a typed answer resolves it). The decision is
// recorded in the transcript: keep-as-drafted is a user answer, and the
// audit trail must show who resolved each assumption.
//
// Two phases accept a keep (owner fix 2026-07-17, the "as is" chase loop):
// review (the resolver cards, unchanged) and drafting WHILE a chase question
// ("qi_" id) is stored. A drafting keep answers the asked question, so it
// writes the real Q&A pair to the transcript (the monotone question counter
// counts it), re-picks the next chase question in the same fenced write (the
// stored one quotes the marker just stripped and would misapply the next
// answer), and flips to review with host copy when the last marker clears.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { placeholderSectionMap } from "@/lib/governance/blueprints";
import {
  CAPS,
  governanceEnabled,
  REVIEW_RESOLVED_SUMMARY,
} from "@/lib/governance/config";
import { applyResolveWrite, fetchOwnedProject } from "@/lib/governance/db";
import {
  attachItemGuesses,
  hydrateChaseSuggestions,
  parseGuessStore,
} from "@/lib/governance/guesses";
import { govError, NOT_FOUND, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import {
  scanConfirmMarkersWithPos,
  stripConfirmMarker,
} from "@/lib/governance/markdown";
import { pickOpenItemQuestion, progressFor } from "@/lib/governance/turn";
import { openConfirmItems, openConfirmTotal } from "@/lib/governance/view";
import type {
  GovernanceDoc,
  GovernanceKind,
  NextQuestion,
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
  const storedQuestion = parse<NextQuestion | null>(row.nextQuestionJson, null);
  const draftingKeep =
    row.status === "drafting" && !!storedQuestion?.id.startsWith("qi_");
  if (row.status !== "review" && !draftingKeep)
    return govError(
      "invalid_request",
      "Keep as drafted works while I am asking about that open item, or during review.",
      409
    );
  // A fresh turn claim owns the row: a strip that bumped rev under the
  // worker would void its final write and waste the brain call. The
  // applyResolveWrite fence backstops this atomically; the pre-check just
  // names the situation honestly (there is no "list" on the chase card).
  if (
    row.turnStartedAt &&
    Date.now() - row.turnStartedAt.getTime() < CAPS.turnStaleMs
  )
    return govError(
      "turn_pending",
      draftingKeep
        ? "Tron is working on the draft right now. Give it a moment and try again."
        : "Tron is folding answers into the draft right now. Give it a moment; the list refreshes when he is done.",
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

  // Drafting keeps must address the marker the stored question asked about:
  // the transcript row below records that question as answered, so a strip
  // of any OTHER marker would make the audit trail lie. The asked marker is
  // the section's first STRICT-parse marker (pickOpenItemQuestion quotes
  // findConfirmMarkers()[0]; the strict first can differ from the lenient
  // first when a malformed opener precedes it, so never compare against the
  // lenient scan here or a keep the question itself invited would 409).
  if (draftingKeep) {
    const askedRef = (storedQuestion?.feeds ?? [])[0];
    const first = scanConfirmMarkersWithPos(section.markdown)[0];
    if (
      askedRef !== `${docSlug}#${sectionId}` ||
      !first ||
      first.excerpt !== excerpt ||
      first.occurrence !== occurrence
    )
      return govError(
        "item_not_found",
        "That item was already resolved, maybe in another tab.",
        409
      );
  }

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
  // A drafting keep ANSWERS the asked chase question: the real Q&A pair goes
  // to the transcript (qi_ id, so the monotone question counter counts it,
  // and review's "Your answers" list can amend it later). The review path
  // keeps its unnumbered "confirm" row.
  const transcript: TranscriptEntry[] = [
    ...parse<TranscriptEntry[]>(row.transcriptJson, []),
    draftingKeep && storedQuestion
      ? {
          qId: storedQuestion.id,
          bankId: null,
          q: storedQuestion.text,
          a: "Kept as drafted.",
          skipped: false,
          askedAt: row.updatedAt.toISOString(),
          answeredAt: now,
        }
      : {
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

  // Drafting keeps advance the interview deterministically: markers remain
  // -> re-pick the next chase question (never null while the lenient total
  // is positive); zero left -> the honest review flip (a stored qi_ question
  // implies bank coverage is complete, so nothing is left to ask).
  const leftTotal = openConfirmTotal(newDocuments);
  // The keep leaves the guess column untouched, so the re-picked chase
  // question hydrates its chips from the live store (a stripped marker's
  // key just goes inert until the next turn write prunes it).
  const guessStore = parseGuessStore(row.openItemGuessesJson);
  const picked = draftingKeep
    ? pickOpenItemQuestion(newDocuments, row.rev + 1)
    : null;
  const advance = draftingKeep
    ? leftTotal > 0
      ? {
          status: "drafting" as const,
          nextQuestionJson: JSON.stringify(
            picked
              ? hydrateChaseSuggestions(picked, newDocuments, guessStore)
              : picked
          ),
          reviewSummary: null,
        }
      : {
          status: "review" as const,
          nextQuestionJson: null,
          reviewSummary: REVIEW_RESOLVED_SUMMARY,
        }
    : undefined;

  const wrote = await applyResolveWrite({
    id: row.id,
    userId: user.userId,
    expectedRev: row.rev,
    expectedStatus: draftingKeep ? "drafting" : "review",
    documents: newDocuments,
    transcript,
    changedSections,
    advance,
  });
  if (!wrote)
    return govError(
      "item_not_found",
      draftingKeep
        ? "The draft changed in another tab. Here is where it is now."
        : "The draft changed in another tab. The list refreshes with where it is now.",
      409
    );

  return okJson({
    rev: row.rev + 1,
    status: advance ? advance.status : "review",
    changedSections,
    placeholderSections: placeholderSectionMap(kind, newDocuments),
    nextQuestion:
      advance && advance.nextQuestionJson
        ? (JSON.parse(advance.nextQuestionJson) as NextQuestion)
        : null,
    reviewSummary: advance ? advance.reviewSummary : row.reviewSummary,
    progress: progressFor(kind, new Set(covered)),
    // The keep write leaves the guess column alone (orphaned keys are inert;
    // the next turn write prunes them), so remaining items keep their chips.
    openConfirmItems: attachItemGuesses(
      openConfirmItems(newDocuments),
      guessStore
    ),
    openConfirmTotal: leftTotal,
    documents: newDocuments,
  });
}
