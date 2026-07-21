// Bank detection + switch-card mechanics (§5.12). When research on a
// non-FFIEC project concludes the company is likely a bank, the run pauses
// BEFORE turn zero (nothing expensive is drafted for the wrong kind) and the
// user decides: switch to the FFIEC offering or stay. Everything here is
// deterministic host code: zero AI calls, zero Tavily spend, no probe slots.
//
// Detection scope is deliberately conservative (banks and thrifts, not
// credit unions or partner-bank fintechs): a wrong "you look like a bank"
// pause is worse than a missed one, and credit unions can pick the FFIEC
// card directly. Signals below the gate never pause; that limitation is
// accepted and documented.

import type {
  BankProfile,
  GovernanceKind,
  NextQuestion,
  ResearchBrief,
  TranscriptEntry,
} from "./types";
import type { LbrMatch } from "./lbr";
import { fmtAssetsMil, fmtAsOf } from "./lbr";

/** Institution-term class: the company IS a depository institution. */
const CLASS_INSTITUTION =
  /\b(bank|banking|savings (?:bank|institution|association)|bancorp|bancshares|trust company)\b/i;
/** Regulator/insurance class: supervision or deposit-insurance evidence. */
const CLASS_REGULATOR =
  /\b(FDIC|OCC|Federal Reserve|member FDIC|equal housing lender|GLBA|state[- ]chartered)\b/i;
/** Partner-bank pattern: fintechs attributing banking services to a third
 * party ("Banking services provided by X Bank, Member FDIC"). Suppresses the
 * keyword path; only an LBR match may still fire. */
const PARTNER_BANK =
  /\b(?:banking services|deposit(?:s| accounts?)?|(?:debit |credit )?cards?) (?:are |is )?(?:provided|issued|held|offered) by\b/i;

export interface BankSignal {
  likely: boolean;
  evidence: string[]; // pause-card lines, max 3, captured at detection time
}

/**
 * Deterministic bank detection over the finished research brief plus the
 * optional LBR match. The LBR arm requires corroboration (a keyword hit or
 * the match's own city/state agreement encoded as confidence "high"): the
 * release is full of common-word bank names, so an LBR row alone is never
 * sufficient. The keyword arm requires BOTH classes and no partner-bank
 * attribution ("food bank" or "blood bank" never carries FDIC language;
 * a Chime-class fintech carries FDIC language but attributes it away).
 */
export function detectBankSignal(
  brief: ResearchBrief,
  lbrMatch: LbrMatch | null
): BankSignal {
  const hay = [
    brief.companyName,
    brief.companyProfile,
    brief.industryContext,
    brief.sizeAndFootprint,
    ...brief.regulatoryExposure,
  ].join("\n");
  const partnerPattern = PARTNER_BANK.test(hay);
  const nameHasInstitution = CLASS_INSTITUTION.test(brief.companyName);
  const institutionHit = nameHasInstitution || CLASS_INSTITUTION.test(hay);
  const regulatorHit = CLASS_REGULATOR.test(hay);
  const keywordFires = institutionHit && regulatorHit && !partnerPattern;
  const lbrFires =
    lbrMatch !== null &&
    lbrMatch.confidence === "high" &&
    (institutionHit || regulatorHit);
  const likely = keywordFires || lbrFires;
  if (!likely) return { likely: false, evidence: [] };

  const evidence: string[] = [];
  if (lbrMatch && lbrMatch.confidence === "high")
    evidence.push(
      `Listed in the Federal Reserve bank release: ${lbrMatch.bank.name.split("/")[0].trim()}, ${lbrMatch.bank.city}, ${lbrMatch.bank.state}`
    );
  if (institutionHit)
    evidence.push(
      nameHasInstitution
        ? "The company name itself reads as a bank or depository institution"
        : "Public sources describe the company as a bank or depository institution"
    );
  if (regulatorHit)
    evidence.push(
      "Federal supervision or deposit insurance language found in public sources"
    );
  return { likely: true, evidence: evidence.slice(0, 3) };
}

/* ------------------------------------------------------------------ *
 * The qs_ switch card
 * ------------------------------------------------------------------ */

export const SWITCH_CHIP = "Switch to the FFIEC version";
export const STAY_CHIP = "Stay with what I picked";

export function buildSwitchQuestion(rev: number): NextQuestion {
  return {
    id: `qs_${rev}`,
    bankId: null,
    text: "Before I research further: you look like a bank. Want the FFIEC version instead?",
    why: "Examiners read a bank's AI policy against FFIEC guidance. The FFIEC offering drafts for that from the first question; the one you picked does not.",
    suggestions: [SWITCH_CHIP, STAY_CHIP],
    feeds: [],
  };
}

/**
 * Deterministic decision parse. Only the exact chips (trimmed,
 * case-insensitive) or an explicit skip resolve the card; anything else
 * returns null and the route re-presents the card with an error. Freeform
 * text must never silently branch AND waive: the choice is final for the
 * project, so "yes switch please" locking the user onto "stay" would be an
 * unrecoverable wrong guess.
 */
export function parseSwitchDecision(
  answer: string,
  skipped: boolean
): "switch" | "continue" | null {
  if (skipped) return "continue";
  const canon = answer.trim().toLowerCase();
  if (canon === SWITCH_CHIP.toLowerCase()) return "switch";
  if (canon === STAY_CHIP.toLowerCase()) return "continue";
  return null;
}

export const SWITCH_DECISION_ERROR =
  "Pick one of the two options above; I need one of them exactly. This choice is final for this project.";

/* ------------------------------------------------------------------ *
 * The switch reducer (pure, pinned by tests; db.ts applies it fenced)
 * ------------------------------------------------------------------ */

export interface BankSwitchInput {
  kind: GovernanceKind;
  bankProfile: BankProfile;
  transcript: TranscriptEntry[];
  question: NextQuestion; // the stored qs_ card being answered
  answer: string;
  skipped: boolean;
  now: string; // ISO
}

export interface BankSwitchResult {
  kind: GovernanceKind; // "ffiec_aup" on switch, unchanged on continue
  reScaffold: boolean; // true => documents_json := scaffoldDocuments(kind)
  bankProfile: BankProfile; // with decision + decidedAt merged
  transcript: TranscriptEntry[]; // with the appended qs_ row
}

/** Pure state computation for a bank-check decision. The caller (db.ts)
 * writes it in ONE statement fenced on status='bank_check' AND the expected
 * rev, clearing turn columns and bumping rev per the write invariants. */
export function applyBankSwitch(
  input: BankSwitchInput,
  decision: "switch" | "continue"
): BankSwitchResult {
  const row: TranscriptEntry = {
    qId: input.question.id,
    bankId: null,
    q: input.question.text,
    a: input.skipped ? "" : input.answer.trim(),
    skipped: input.skipped,
    askedAt: input.now,
    answeredAt: input.now,
    feeds: [],
  };
  return {
    kind: decision === "switch" ? "ffiec_aup" : input.kind,
    reScaffold: decision === "switch",
    bankProfile: {
      ...input.bankProfile,
      decision,
      decidedAt: input.now,
    },
    transcript: [...input.transcript, row],
  };
}

/* ------------------------------------------------------------------ *
 * FF-02 tier write-back + suggestion hydration (§5.12)
 * ------------------------------------------------------------------ */

/** The four static tier chips; MUST stay the same partition as assetTier. */
export const TIER_CHIPS: { chip: string; tier: BankProfile["tier"] }[] = [
  { chip: "Under $1 billion", tier: "under-1b" },
  { chip: "$1 billion to $10 billion", tier: "1b-10b" },
  { chip: "$10 billion to $30 billion", tier: "10b-30b" },
  { chip: "Over $30 billion", tier: "over-30b" },
];

/** View-time hydrated confirm chip when the LBR lookup found the bank. */
export function lbrSuggestion(lbr: NonNullable<BankProfile["lbr"]>): string {
  return `About ${fmtAssetsMil(lbr.consolAssetsMil)} in consolidated assets, per the Federal Reserve bank list as of ${fmtAsOf(lbr.asOf)}`;
}

/**
 * Deterministic FF-02 answer -> tier mapping, written back into
 * bank_profile_json in the SAME fenced statement that applies the turn (the
 * proportionality calibration must follow the user's answer, not just the
 * LBR lookup; savings institutions and credit unions have no LBR row at
 * all). Freeform answers try a lenient "$N billion/million" parse; anything
 * unparseable leaves the stored tier untouched (the model still sees the
 * verbatim answer in the transcript).
 */
export function tierFromAnswer(
  answer: string,
  lbr: BankProfile["lbr"]
): BankProfile["tier"] | null {
  const canon = answer.trim().toLowerCase();
  for (const { chip, tier } of TIER_CHIPS)
    if (canon === chip.toLowerCase()) return tier;
  if (lbr && canon === lbrSuggestion(lbr).toLowerCase()) {
    const mil = lbr.consolAssetsMil;
    if (mil < 1_000) return "under-1b";
    if (mil < 10_000) return "1b-10b";
    if (mil < 30_000) return "10b-30b";
    return "over-30b";
  }
  const m = /\$?\s*([\d,.]+)\s*(billion|bn|b\b|million|mm|m\b|trillion)/i.exec(
    answer
  );
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) {
      const unit = m[2].toLowerCase();
      const mil =
        unit.startsWith("t") ? n * 1_000_000 : unit.startsWith("b") ? n * 1_000 : n;
      if (mil < 1_000) return "under-1b";
      if (mil < 10_000) return "1b-10b";
      if (mil < 30_000) return "10b-30b";
      return "over-30b";
    }
  }
  return null;
}
