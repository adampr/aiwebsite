// Quality assessment for team work submissions (§5.16 quality round,
// 2026-09-18). Two panel stages, one pure reconciliation. The ASSESSOR
// scores the SUBMITTED WORK ITSELF (from its documents, never the card
// copy) across the five fixed WORK_QUALITY_DIMENSIONS; the REFUTER's job is
// to knock each score down; reconcileQuality resolves the two in code, with
// quoteInCorpus as the only arbiter of evidence, so an invented quote can
// never mark a score supported and an invented challenge can never contest
// one.
//
// NON-GATING BY DESIGN (the invariant every caller must keep): nothing in
// this module can fail, hold, or delay a panel run. A null assessor result
// means the row carries no assessment; a null refuter result means an
// uncontested one. The output never feeds synthesis, lint, the disclosure
// gate, or card_json. It RENDERS on three surfaces (owner ruling
// 2026-09-18, repealing the same morning's internal-only rule): the public
// /work card as ONE compact score line (publicQualityLine below: scored
// dimensions only, "(contested)" marks, source-attributed), and in full on
// the two internal surfaces (/admin/work and the submitter's own
// /work/submit list), which alone show the refuter's direction and reason,
// the unsupported dimensions, and the strengths/improvements/missed-risks
// prose.
//
// This file is PURE (config + lint imports only, both client-safe): the
// no-DB test:work suite pins reconcileQuality here. The prompt builders
// take the untrusted-input frame as an argument rather than importing it,
// so panel.ts stays the one owner of UNTRUSTED_FRAME.

import {
  WORK_QUALITY_DIMENSIONS,
  type WorkQualityDimensionKey,
} from "./config";
import { quoteInCorpus } from "./lint";

// Length caps for model-written strings (model JSON is untrusted; a 2 MB
// "note" must never reach the row or a rendered surface).
const QUOTE_MAX_CHARS = 400;
const NOTE_MAX_CHARS = 200;
const REASON_MAX_CHARS = 240;
const SENTENCE_MAX_CHARS = 300;
const LIST_MAX = 3;
const MISSED_RISKS_MAX = 2;

export interface QualityChallenge {
  direction: "too_high" | "too_low";
  reason: string;
}

export interface QualityDimension {
  key: WorkQualityDimensionKey;
  /** 1-5, or null when the assessor's quote failed verification or the
   * score itself was unusable. */
  score: number | null;
  quote: string;
  note: string;
  /** No evidence-backed usable score: the quote failed verification (the
   * score was discarded) or the quote verified but the score was junk.
   * Either way the dimension is kept, as a visible gap, and both surfaces
   * key their "no verified evidence" caption on this state. */
  unsupported: boolean;
  /** A refuter challenge with a VERIFIED quote survives reconciliation. The
   * score is deliberately not changed: humans read contested marks; code
   * never invents a compromise number. */
  contested: boolean;
  challenge: QualityChallenge | null;
}

export interface WorkQualityAssessment {
  version: 1;
  dimensions: QualityDimension[];
  strengths: string[];
  improvements: string[];
  missedRisks: string[];
  contestedCount: number;
  assessedAt: string;
}

const DIMENSION_KEYS = WORK_QUALITY_DIMENSIONS.map((d) => d.key);

function isDimensionKey(v: unknown): v is WorkQualityDimensionKey {
  return (
    typeof v === "string" &&
    (DIMENSION_KEYS as readonly string[]).includes(v)
  );
}

/** Trimmed, capped string, or null when the value is not a usable string. */
function cappedString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s.slice(0, max) : null;
}

/** Up to `max` short sentences out of an untrusted array. Junk entries are
 * dropped, never coerced. */
function sentenceList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    const s = cappedString(entry, SENTENCE_MAX_CHARS);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Integer score 1-5 out of an untrusted value, or null. Finite numbers are
 * rounded and clamped; anything else is not a score. */
function cleanScore(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(5, Math.max(1, Math.round(v)));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reconcile the assessor's and the refuter's untrusted JSON into the stored
 * assessment, or null when the assessor output is unusable (not an object,
 * or no dimension entry survives shape validation). Rules, in order:
 *   - assessor dimension entries: recognized key, first occurrence wins;
 *     a missing or unverifiable quote nulls the score and marks the
 *     dimension unsupported (a score without evidence is discarded), and a
 *     verified quote whose score is unusable (non-numeric) is likewise
 *     unsupported: the state means "no evidence-backed usable score".
 *   - refuter challenges: recognized key naming a surviving dimension,
 *     recognized direction, and a quote that verifies against the corpus;
 *     anything else is dropped. The rule is symmetric with the assessor's
 *     on purpose (an invented quote cannot move a score in EITHER
 *     direction; simplicity beats asymmetry).
 *   - a surviving challenge marks the dimension contested and attaches
 *     {direction, reason}; the score itself never moves.
 */
export function reconcileQuality(
  assessor: unknown,
  refuter: unknown,
  corpusText: string
): WorkQualityAssessment | null {
  if (!isPlainObject(assessor)) return null;
  const seen = new Set<string>();
  const dimensions: QualityDimension[] = [];
  const rawDims = Array.isArray(assessor.dimensions) ? assessor.dimensions : [];
  for (const entry of rawDims) {
    if (!isPlainObject(entry)) continue;
    if (!isDimensionKey(entry.key) || seen.has(entry.key)) continue;
    seen.add(entry.key);
    const quote = cappedString(entry.quote, QUOTE_MAX_CHARS);
    const supported = quote !== null && quoteInCorpus(quote, corpusText);
    const score = supported ? cleanScore(entry.score) : null;
    dimensions.push({
      key: entry.key,
      score,
      quote: quote ?? "",
      note: cappedString(entry.note, NOTE_MAX_CHARS) ?? "",
      // Tracks the SCORE, not just the quote: a verified quote with a junk
      // score leaves nothing a surface could honestly caption either, and
      // both renderers key their caption on score === null.
      unsupported: score === null,
      contested: false,
      challenge: null,
    });
  }
  if (dimensions.length === 0) return null;

  if (isPlainObject(refuter)) {
    const rawChallenges = Array.isArray(refuter.challenges)
      ? refuter.challenges
      : [];
    for (const entry of rawChallenges) {
      if (!isPlainObject(entry)) continue;
      if (entry.direction !== "too_high" && entry.direction !== "too_low")
        continue;
      const quote = cappedString(entry.quote, QUOTE_MAX_CHARS);
      if (quote === null || !quoteInCorpus(quote, corpusText)) continue;
      const dim = dimensions.find((d) => d.key === entry.key && !d.contested);
      if (!dim) continue;
      dim.contested = true;
      dim.challenge = {
        direction: entry.direction,
        reason: cappedString(entry.reason, REASON_MAX_CHARS) ?? "",
      };
    }
  }

  return {
    version: 1,
    dimensions,
    strengths: sentenceList(assessor.strengths, LIST_MAX),
    improvements: sentenceList(assessor.improvements, LIST_MAX),
    missedRisks: isPlainObject(refuter)
      ? sentenceList(refuter.missedRisks, MISSED_RISKS_MAX)
      : [],
    contestedCount: dimensions.filter((d) => d.contested).length,
    assessedAt: new Date().toISOString(),
  };
}

/** Defensive reader for the stored column: quality_json may be null forever
 * on old rows, and a row written by a future version must degrade to null,
 * never to a crash in a projection or a rendered surface. The shape is
 * REBUILT field by field, never cast: the only production writer is
 * setQualityAssessment(reconcileQuality(...)), but hand SQL on
 * work_submissions has real precedent in this repo, and one malformed
 * version-1 row must not 500 the whole /admin/work render. */
export function parseQualityJson(
  json: string | null
): WorkQualityAssessment | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isPlainObject(parsed)) return null;
    if (parsed.version !== 1) return null;
    if (!Array.isArray(parsed.dimensions)) return null;
    const dimensions: QualityDimension[] = [];
    for (const entry of parsed.dimensions) {
      if (!isPlainObject(entry) || !isDimensionKey(entry.key)) continue;
      const rawChallenge = entry.challenge;
      const challenge: QualityChallenge | null =
        isPlainObject(rawChallenge) &&
        (rawChallenge.direction === "too_high" ||
          rawChallenge.direction === "too_low")
          ? {
              direction: rawChallenge.direction,
              reason:
                cappedString(rawChallenge.reason, REASON_MAX_CHARS) ?? "",
            }
          : null;
      const score = cleanScore(entry.score);
      dimensions.push({
        key: entry.key,
        score,
        quote: cappedString(entry.quote, QUOTE_MAX_CHARS) ?? "",
        note: cappedString(entry.note, NOTE_MAX_CHARS) ?? "",
        unsupported: entry.unsupported === true || score === null,
        contested: challenge !== null && entry.contested === true,
        challenge,
      });
    }
    if (dimensions.length === 0) return null;
    return {
      version: 1,
      dimensions,
      strengths: sentenceList(parsed.strengths, LIST_MAX),
      improvements: sentenceList(parsed.improvements, LIST_MAX),
      missedRisks: sentenceList(parsed.missedRisks, MISSED_RISKS_MAX),
      contestedCount: dimensions.filter((d) => d.contested).length,
      assessedAt:
        typeof parsed.assessedAt === "string" ? parsed.assessedAt : "",
    };
  } catch {
    return null;
  }
}

/** The one line the PUBLIC card prints (owner ruling 2026-09-18; the
 * /work card template calls this and nothing else). Pure and pinned by
 * test:work, so the test covers exactly what renders. Rules:
 *   - only dimensions with a numeric score render, as `key N/5`, in stored
 *     (rubric) order; an unsupported or null-score dimension is OMITTED, not
 *     captioned: the public page must never print "no verified evidence"
 *     against a colleague's tool. No scored dimension at all -> null, and
 *     the caller renders nothing (the time-saved precedent: a line that
 *     says nothing is worse than no line).
 *   - a contested dimension carries " (contested)" only; the refuter's
 *     direction and reason stay on the internal surfaces, as do the
 *     strengths/improvements/missedRisks prose.
 *   - the line names its source, " · assessed by the editorial panel" (the
 *     noun the /work intro uses for the same panel), because
 *     /work opens with "Every claim below is drawn from the submitted
 *     documents": every surviving score IS quote-backed, and saying who
 *     scored it is what keeps that promise honest (the "reported by the
 *     submitter" precedent on the time-saved line).
 *   - middots as separators; never an em or en dash (site rule on visible
 *     copy). Keys come from WORK_QUALITY_DIMENSIONS, never from the row, so
 *     no model-written string reaches the public page through here.
 * Rendered: `Quality · documentation 4/5 · robustness 3/5 (contested) ·
 * safety 5/5 · assessed by the editorial panel`. */
export function publicQualityLine(
  assessment: WorkQualityAssessment | null
): string | null {
  if (!assessment) return null;
  const parts: string[] = [];
  // Defence in depth over the reader: score and unsupported are coupled by
  // reconcileQuality, but a hand-edited row can decouple them, and a
  // repeated key must not print twice.
  const seen = new Set<string>();
  for (const d of assessment.dimensions) {
    if (d.score === null || d.unsupported || !isDimensionKey(d.key)) continue;
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    parts.push(`${d.key} ${d.score}/5${d.contested ? " (contested)" : ""}`);
  }
  if (parts.length === 0) return null;
  return `Quality · ${parts.join(" · ")} · assessed by the editorial panel`;
}

/** The rubric lines the assessor sees, verbatim from config. */
function rubricLines(): string {
  return WORK_QUALITY_DIMENSIONS.map((d) => `- ${d.key}: ${d.rubric}`).join(
    "\n"
  );
}

// Both prompts describe the WORK, never the process (the meta-copy
// precedent): the prose fields render only on the internal surfaces, but
// prose about "the panel" or "this review" in a note or improvement line is
// still commentary about our pipeline instead of the tool, so it is
// forbidden at the prompt.
const NO_PROCESS_PROSE =
  "Every prose field describes the submitted work itself. Never mention this " +
  "review, the panel, critics, pipelines, or editorial process in any field.";

/** System + user prompt for the quality assessor stage. `frame` is
 * panel.ts's UNTRUSTED_FRAME; `docs` is its docsBlock output. */
export function qualityAssessorPrompts(
  frame: string,
  docs: string
): { system: string; user: string } {
  return {
    system:
      "You are the quality assessor on an internal editorial panel. You " +
      "evaluate the SUBMITTED WORK ITSELF from its documents: the tool, its " +
      "design, and its documentation, not the card copy and not the " +
      "submitter. Score each dimension 1 to 5 against its rubric. Every " +
      "score MUST be paired with an exact supporting line quoted verbatim " +
      "from the documents; a score without a verifiable supporting quote " +
      `will be discarded. ${NO_PROCESS_PROSE} ${frame}`,
    user:
      `${docs}\n\nScore the submitted work on exactly these five dimensions, rubrics verbatim:\n${rubricLines()}\n\n` +
      `Return {"dimensions": [{"key": one of documentation, robustness, safety, clarity, reusability, "score": integer 1-5, "quote": the exact supporting line from the documents, "note": at most 25 words}], "strengths": [1-3 short sentences], "improvements": [1-3 short, concrete sentences about the work itself]}.`,
  };
}

/** System + user prompt for the quality refuter stage. Sees the documents
 * AND the assessor's output; its mandate is refutation. */
export function qualityRefuterPrompts(
  frame: string,
  docs: string,
  assessor: Record<string, unknown>
): { system: string; user: string } {
  return {
    system:
      "You are the quality refuter on an internal editorial panel. Your JOB " +
      "is to refute the quality assessment below: for each scored dimension, " +
      "build the strongest case that the score is wrong, in either " +
      "direction, grounded in the documents. A challenge without an exact " +
      "contradicting line quoted verbatim from the documents will be " +
      "discarded. Return an empty challenges array only when you genuinely " +
      `cannot build a case against any score. ${NO_PROCESS_PROSE} ${frame}`,
    user:
      `${docs}\n\nQuality assessment to refute:\n${JSON.stringify(assessor).slice(0, 8000)}\n\n` +
      `Return {"challenges": [{"key": the dimension key, "direction": "too_high" or "too_low", "reason": at most 30 words, "quote": the exact document line that contradicts the assessor's reading}], "missedRisks": [0-2 short sentences naming real risks the assessment missed]}.`,
  };
}
