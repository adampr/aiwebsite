"use client";

// The RFP workspace client island (§5.17.1).
//
// Two columns at lg: the draft on the left, a four-pane rail on the right
// (Questions / Coverage / Checks / Tron). Below lg both columns stay MOUNTED
// and are toggled with hidden/block, so a half-typed answer survives a tab
// switch. The rail itself waits for the document: it is unmounted until a
// section exists and for the whole of the first draft run (`railHidden`).
//
// THE FLOW (ported from the governance builder's interaction pattern): give
// it the RFP, press one button, and the whole response drafts section by
// section — then the open questions are answered ONE AT A TIME, and each
// answer visibly lands in the working document (cyan rail + 900ms wash +
// scroll-to, the same .doc-sec--changed / .doc-sec--flash grammar, with the
// remount key so a twice-changed section re-animates). Drafting stays one
// section per call underneath: the loop lives HERE, client-driven, so the
// shared brain semaphore is never held for a whole document and a mid-run
// deploy loses one section, not seventeen.
//
// EDITING IS PER SECTION AND TEXT ONLY. `cites` and `generatedBy` are never
// sent from here and are re-attached server-side from the stored record.
// Rule A5 only demands citations when generatedBy is "llm", and rule C1's
// staleness sweep joins on cites, so a client that could clear either field
// would quietly launder an uncited claim past both.
//
// PRICING QUESTIONS SEND QUANTITIES ONLY. The server computes every figure
// from the rate card in force (rules B5/B7); the quote rendered below the
// sections is engine output, printed, never calculated here.

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";

// This component is server-rendered (page.tsx statically imports it), and
// React warns on useLayoutEffect during SSR; the server branch is inert
// anyway because the measurement needs a live DOM.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
import { When } from "@/components/when";
import { LocalTime } from "@/components/local-time";
import {
  minimumSentence,
  parseInputsSource,
  parseQuoteInputs,
  quantityLabel,
  type FmuSource,
  type QuoteInputs,
} from "@/lib/rfp/quote";
// TYPES ONLY from staff-count: its scanner (lookbehind regexes, whole
// document passes) runs in page.tsx and must never enter the client bundle.
import type { StatedStaff } from "@/lib/rfp/staff-count";
import { normalizeGapQuestion } from "@/lib/rfp/gaps";
import {
  isCanonicalReferencesQuestion,
  referencesCountWord,
} from "@/lib/rfp/references-question";
import {
  DEFAULT_LETTER_BODY,
  DOC_LABEL,
  LETTER_LABEL,
  LETTER_TITLE,
} from "@/lib/rfp/letter";
import { COMPANY_SIGNATURE, type PersonSignature } from "@/lib/rfp/signature";
import type { PricingQuote, Violation } from "@/lib/rfp/content-model";
import type { GateResult } from "@/lib/rfp/validators/gate";
// Pure and client-safe by contract (no lookbehinds, no server imports):
// findingSig is the PERSISTED dismissal key the checks route validates, and
// the fix recipes only read the violation + the drafted labels.
import { findingSig } from "@/lib/rfp/check-ignores";
import { fixInstruction, fixRecipe } from "@/lib/rfp/check-fixes";
// Pure and client-safe by contract (no lookbehinds, type-only imports).
import {
  draftBlockSummary,
  interleave,
  sanitizeStoredBlocks,
  tableColumnFractions,
  type DraftBlock,
} from "@/lib/rfp/draft-blocks";
// Pure and client-safe by contract (an advance table, no Node imports).
import { tileFitEm } from "@/lib/rfp/tile-fit";
// Client references (§5.17.9): the picker answers the references question
// with structured entries; the card tables are the one spec the exports
// draw from too. Both client-safe (references-ask.ts is NOT, never import it).
import {
  referenceCardTables,
  type ReferenceEntry,
} from "@/lib/rfp/references-block";
import { ReferencesPicker } from "./references-picker";
import { ReadAgain } from "./read-again";

type Section = {
  label: string;
  title: string;
  paragraphs: string[];
  cites: string[];
  gaps: { question: string; why: string }[];
  generatedBy: "llm" | "human";
  updatedAt: string;
  /** Server stamp: the references question was answered on this section. */
  referencesAnswered?: boolean;
  /** Visual blocks as STORED (§5.17): always read through
   *  sanitizeStoredBlocks before rendering, never trusted as typed. */
  blocks?: DraftBlock[];
};

/** The server-built visuals a person can add to a section by hand: the
 *  choices behind one "Add visual" control (three Adds in the row pushed
 *  the timestamp onto a third line at the lg pane). */
type VisualAction = "about" | "service-stats" | "onboarding";
const VISUAL_ADDS: { action: VisualAction; add: string }[] = [
  { action: "about", add: "Company snapshot" },
  { action: "service-stats", add: "Service stats" },
  { action: "onboarding", add: "Onboarding timeline" },
];

/** The longest run of non-space characters in a cell: the width a table
 *  column must hold, since a cell never splits a word. */
function longestWord(s: string): number {
  let max = 0;
  for (const w of s.split(/\s+/)) if (w.length > max) max = w.length;
  return max;
}

type Requirement = {
  id: string;
  structureLabel: string;
  text: string;
  mandatory: boolean;
  kind: string;
};

type Pane = "questions" | "coverage" | "checks" | "tron";

/** One entry in the guided flow. Pricing entries apply instantly; gap
 *  entries take a brain call and say so. */
type OpenQuestion =
  | {
      kind: "pricing";
      key: string;
      field: keyof QuoteInputs;
      text: string;
      why: string;
      input: "number" | "choice" | "yesno";
      choices?: { value: string; label: string }[];
      prefill?: number | null;
      /** Requires at least this value in the number input. */
      min?: number;
      /** One-tap answer at the rate card's monthly minimum. `primary` when
       *  the RFP's own wording (or its silence) makes the minimum the
       *  expected answer; the number box then serves the larger count. */
      quick?: { label: string; value: number; primary: boolean };
      /** Alternative one-click answer (e.g. "the split is confirmed"). */
      alt?: { label: string; value: number; extra: Partial<QuoteInputs> };
    }
  | {
      kind: "gap";
      key: string;
      /** Every section holding this question, deduped by normalized text:
       *  one answer is woven into each of them. `raw` is THAT section's own
       *  wording — the server matches gap text exactly, so "SOC 2" and
       *  "SOC-2" variants must each be sent as their section recorded them. */
      targets: { label: string; sectionTitle: string; raw: string }[];
      text: string;
      why: string;
    };

const EMPTY_INPUTS: QuoteInputs = {
  fullyManagedUsers: null,
  statesHeadcountOnly: false,
  supportedUserSplitConfirmed: false,
  m365OnlyUsers: null,
  securePlusComputers: null,
  dattoRetention: null,
  dattoUsers: null,
  vulnScanSessionsPerYear: null,
  includeOnboarding: null,
};

/** The cover title the export prints (resolve-draft.ts `cover.title`). The
 *  sheet must show what downloads (owner ruling, round 11), and the stored
 *  document title is often an upload's filename. */
const COVER_TITLE = "Response to Request for Proposal";

/**
 * Everything the user-count question and its provenance row say about staff:
 * the RFP's own headcount sentences, the rate card's monthly minimum, and
 * whether the document places the client inside that minimum. Every field is
 * computed by page.tsx on the server; built once in Workspace so the
 * question and the row can never disagree.
 */
type StaffContext = {
  /** The RFP's staff sentences, deduped, the grounded quote first.
   *  Attacker-controlled: rendered as plain text nodes only. */
  evidence: string[];
  /** The stated RANGE, from the parse that grounded it; null otherwise. */
  range: { lo: number; hi: number } | null;
  /** The monthly minimum in force; null when no rate card exists. */
  floor: { users: number; cents: number } | null;
  /** Non-null = the RFP says the client fits inside the minimum. It only
   *  makes the one-tap minimum the PRIMARY answer; it never seeds a count. */
  assumption: { quote: string } | null;
  /** A larger population shows somewhere in the document. */
  conflict: boolean;
};

function pricingQuestions(
  inputs: QuoteInputs,
  statedStaff: StatedStaff | null,
  staff: StaffContext
): OpenQuestion[] {
  const qs: OpenQuestion[] = [];
  if (inputs.fullyManagedUsers === null) {
    const { floor } = staff;
    // An RFP that stated a single staff count never reaches here: the count
    // was seeded at proposal creation (owner ruling 2026-08-02: stated staff
    // IS the user count until staff says otherwise). A stated RANGE still
    // asks, one prefilled tap, because picking an endpoint silently would be
    // authoring a number the client anchors on. The prefill comes from the
    // SAME parse that grounded the range (page.tsx runs it), never from "any
    // big number in the sentence" (a founding year or street address must
    // not win).
    const { range } = staff;
    // The one-tap minimum answer. OMITTED when the stated evidence clearly
    // exceeds the minimum (an exact count, or a range whose low end, above
    // it): a button that underquotes a document-stated size is a trap, not a
    // shortcut. PRIMARY when the RFP points to the minimum, or says nothing
    // about staff at all (the minimum is then the starting assumption);
    // secondary whenever the RFP does speak to staff without settling it, so
    // the person reads the sentences and decides.
    const evidenceLow = range ? range.lo : (statedStaff?.count ?? null);
    const hasEvidence = staff.evidence.length > 0;
    const quick =
      floor && !(evidenceLow !== null && evidenceLow > floor.users)
        ? {
            label: `Use up to ${floor.users} users (${fmtCents(floor.cents)} a month)`,
            value: floor.users,
            primary:
              staff.assumption !== null || (!hasEvidence && !staff.conflict),
          }
        : undefined;
    if (floor && staff.assumption)
      // The RFP's own wording places the client inside the minimum ("fewer
      // than 10 employees", a range of 10 to 12). Nothing is seeded from
      // wording like that: the question is asked, with the one-tap minimum
      // as its primary answer. This branch WINS over the range branch below
      // (a "12" prefilled under a primary "Use up to 15" is two answers),
      // and carries no prefill: the primary button is the answer offered.
      qs.push({
        kind: "pricing",
        key: "p:fullyManagedUsers",
        field: "fullyManagedUsers",
        text: `The RFP points to the monthly minimum. Quote up to ${floor.users} fully managed users?`,
        why: "",
        input: "number",
        quick,
      });
    else if (range)
      qs.push({
        kind: "pricing",
        key: "p:fullyManagedUsers",
        field: "fullyManagedUsers",
        text: "The RFP states a range for staff count. Which number should this quote use?",
        why: quick?.primary
          ? "You can change the count later in the rate card."
          : "The larger number is prefilled. You can change the count later in the rate card.",
        input: "number",
        prefill: quick?.primary ? undefined : range.hi,
        quick,
      });
    else
      qs.push({
        kind: "pricing",
        key: "p:fullyManagedUsers",
        field: "fullyManagedUsers",
        text: "How many people need full IT support (fully managed users)?",
        why: !floor
          ? "The quantity the monthly service and the monthly minimum are computed from."
          : staff.conflict
            ? "The RFP's wording suggests a team larger than the minimum. Enter the count."
            : !hasEvidence
              ? "With no count in the RFP, the minimum is the starting assumption."
              : "Decide from the RFP's own wording above.",
        input: "number",
        // Defense for a proposal that predates extraction: the grounded
        // count is at least offered, never silently applied. No prefill
        // under a primary one-tap: that button is the answer offered.
        prefill: quick?.primary ? undefined : (statedStaff?.count ?? undefined),
        quick,
      });
  }
  // A zero estimate stays OPEN (matches the quote engine's needsSplit): the
  // two-view rule cannot be satisfied by an estimate of zero, only by a
  // real estimate or a confirmed split, and silently accepting 0 used to
  // wedge export behind a B4 block with the Questions pane reading "done".
  if (
    inputs.statesHeadcountOnly &&
    !inputs.supportedUserSplitConfirmed &&
    !inputs.m365OnlyUsers
  )
    qs.push({
      kind: "pricing",
      key: "p:m365OnlyUsers",
      field: "m365OnlyUsers",
      text: "The RFP states headcount, not supported users. Roughly how many of those people would need only Microsoft 365 support?",
      why: "Headcount is not user count. Two illustrations are quoted so the client never anchors on the largest number available. If the client has confirmed everyone needs full support, use the button below.",
      input: "number",
      min: 1,
      alt: {
        label: "The client confirmed: everyone fully managed",
        value: 0,
        extra: { supportedUserSplitConfirmed: true },
      },
    });
  if (inputs.securePlusComputers === null)
    qs.push({
      kind: "pricing",
      key: "p:securePlusComputers",
      field: "securePlusComputers",
      text: "How many computers should XL Secure+ cover? (0 to leave it out)",
      why: "Optional per-computer security add-on. Quoted per computer per month.",
      input: "number",
    });
  if (inputs.dattoRetention === null)
    qs.push({
      kind: "pricing",
      key: "p:dattoRetention",
      field: "dattoRetention",
      text: "Datto SaaS Protection retention tier?",
      why: "Both tiers exist so the client can pick. “Present both” totals the 1-year tier and notes the other.",
      input: "choice",
      choices: [
        { value: "1yr", label: "1-year retention" },
        { value: "infinite", label: "Infinite retention" },
        { value: "both", label: "Present both tiers" },
        { value: "none", label: "Not in this quote" },
      ],
    });
  if (
    inputs.dattoRetention !== null &&
    inputs.dattoRetention !== "none" &&
    inputs.dattoUsers === null
  )
    qs.push({
      kind: "pricing",
      key: "p:dattoUsers",
      field: "dattoUsers",
      text: "How many users does Datto SaaS Protection cover?",
      why: "Usually everyone with a mailbox.",
      input: "number",
      prefill: inputs.fullyManagedUsers,
    });
  if (inputs.vulnScanSessionsPerYear === null)
    qs.push({
      kind: "pricing",
      key: "p:vulnScanSessionsPerYear",
      field: "vulnScanSessionsPerYear",
      text: "Vulnerability scanning: how many sessions per year? (0 to leave it out)",
      why: "Priced per session, so the proposal must state a cadence.",
      input: "number",
    });
  if (inputs.includeOnboarding === null)
    qs.push({
      kind: "pricing",
      key: "p:includeOnboarding",
      field: "includeOnboarding",
      text: "Include onboarding? It is a one-time fee equal to one month of the base managed service.",
      why: "Base means the fully managed line with the minimum applied, not the all-in total.",
      input: "yesno",
    });
  return qs;
}

export function Workspace({
  documentId,
  proposalId: initialProposalId,
  structure: initialStructure,
  requirements: initialRequirements,
  sections: initialSections,
  rev: initialRev,
  pricing: initialPricing,
  pricingInputs: initialInputs,
  gateResult: initialGate,
  busy: initialBusy,
  genError,
  autoDraft,
  docStatus,
  archived,
  clientName,
  coverClientName,
  statedStaff,
  staffEvidence,
  staffRange,
  minimumEvidence,
  staffConflict,
  refsMissing: initialRefsMissing,
  referencesQuestions,
  minimumUsers,
  minimumMonthlyCents,
  preparedBy,
  ownerEmail,
  signature,
}: {
  documentId: string;
  proposalId: string | null;
  structure: { label: string; title: string }[];
  requirements: Requirement[];
  sections: Section[];
  rev: number;
  pricing: PricingQuote | null;
  pricingInputs: QuoteInputs | null;
  gateResult: GateResult | null;
  busy: boolean;
  genError: string | null;
  autoDraft: boolean;
  docStatus: string;
  archived: boolean;
  clientName: string | null;
  /** Who the export's cover names: the client, else the proposal title. */
  coverClientName: string | null;
  statedStaff: StatedStaff | null;
  /** Verbatim RFP headcount sentences, deduped server-side, the grounded
   *  quote first. Attacker-controlled: text nodes only. */
  staffEvidence: string[];
  /** The stated staff RANGE (statedStaff.count === null), parsed server-side. */
  staffRange: { lo: number; hi: number } | null;
  /** Non-null = the RFP places the client inside the monthly minimum, so the
   *  one-tap minimum is the primary answer. Server-computed; never a seed. */
  minimumEvidence: { quote: string } | null;
  /** The document shows a larger population somewhere (server conflict
   *  scan): the minimum one-tap is then never the primary answer, even
   *  when no countable staff sentence was found. */
  staffConflict: boolean;
  /** Sections whose requirements ask for client references while the draft
   *  neither lists any nor has the question open (server-computed at load). */
  refsMissing: { label: string; count: number | null }[];
  /** Model-worded references questions open at load, exact stored text. */
  referencesQuestions: string[];
  /** The rate card's monthly minimum; both null when no card is in force. */
  minimumUsers: number | null;
  minimumMonthlyCents: number | null;
  preparedBy: string;
  ownerEmail: string;
  signature: PersonSignature;
}) {
  const router = useRouter();
  // Structure and requirements are state, not plain props: an accepted Tron
  // retitle or remove (§5.17.1) changes them, and the document, the
  // Coverage pane, and the section picker must follow without a reload.
  const [structure, setStructure] = useState(initialStructure);
  const [requirements, setRequirements] = useState(initialRequirements);
  const [sections, setSectionsState] = useState<Section[]>(initialSections);
  // Ref mirror so async pollers diff against the CURRENT sections, not the
  // closure's. A state-updater callback is not guaranteed to run before the
  // poller needs the answer.
  const sectionsRef = useRef(initialSections);
  const setSections = useCallback(
    (next: Section[] | ((prev: Section[]) => Section[])) => {
      const value =
        typeof next === "function" ? next(sectionsRef.current) : next;
      sectionsRef.current = value;
      setSectionsState(value);
    },
    []
  );
  const [proposalId, setProposalId] = useState(initialProposalId);
  const [pricing, setPricing] = useState<PricingQuote | null>(initialPricing);
  const [inputs, setInputs] = useState<QuoteInputs>(
    initialInputs ??
      // Pre-proposal display seed only: the server writes the real seed at
      // proposal creation. This keeps the already-answered user-count
      // question from flashing before the first section is drafted.
      (statedStaff && statedStaff.count !== null
        ? { ...EMPTY_INPUTS, fullyManagedUsers: statedStaff.count }
        : EMPTY_INPUTS)
  );
  // Where the fully managed count came from. Server-derived: every PUT and
  // poll response re-states it, and the client always adopts the server's
  // verdict (a locally mirrored flip could keep a stale "From the RFP"
  // badge on a hand-edited number).
  const [fmuSource, setFmuSource] = useState<FmuSource>(
    initialInputs
      ? parseInputsSource(initialInputs)
      : statedStaff && statedStaff.count !== null
        ? "rfp"
        : null
  );
  const [gateResult, setGateResult] = useState<GateResult | null>(initialGate);
  // `pane` is the ONE source of truth for which rail pane renders; `mobile`
  // only decides draft-vs-rail below lg. Rendering off both used to stack
  // two panes whenever they disagreed (first tap of any mobile rail tab).
  // The Questions pane has nothing to offer before a section is drafted
  // (owner ruling 2026-09-30: until it is usable it must not be openable),
  // so the rail opens on Coverage until then and its tab is disabled; the
  // first landed section flips it on and brings it forward. Since the
  // second 2026-09-30 directive (`railHidden` below) the WHOLE rail is
  // unmounted until the document exists, which subsumes this: the disabled
  // tab is now only reachable on a structure-less RFP, where the rail stays
  // for its Coverage list. Kept as it is; it is harmless there.
  const [pane, setPane] = useState<Pane>(
    initialSections.length > 0 ? "questions" : "coverage"
  );
  const [mobile, setMobile] = useState<"draft" | Pane>("draft");
  // The rail self-scrolls at lg; without a reset, leaving a long Coverage
  // list clamps the next pane to the BOTTOM of its shorter content.
  const railRef = useRef<HTMLDivElement | null>(null);
  // Someone asked to SEE a pane ("Answer these", "Edit references", "Run
  // checks" all come through showPane): while the initial run is still
  // hiding the rail, that request wins and the rail comes forward. Never
  // reset: it only matters while `initialDrafting` holds.
  const [railPeek, setRailPeek] = useState(false);
  const showPane = useCallback(
    (k: Pane) => {
      if (k === "questions" && sectionsRef.current.length === 0) return;
      setPane(k);
      setMobile(k);
      setRailPeek(true);
      if (railRef.current) railRef.current.scrollTop = 0;
    },
    []
  );
  const [busy, setBusy] = useState(initialBusy);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // ---- visual blocks (add a server-built one, remove any) ----
  // Lives HERE, never inside the flash-keyed section div: the write ends in
  // showChanged, which remounts that div. `busy` names the one control that
  // is working; every visual control is disabled while any is in flight,
  // because each write is a CAS on the proposal rev.
  const [visualBusy, setVisualBusy] = useState<string | null>(null);
  // Shown where the person pressed: under the block for a Remove
  // (blockId), under the section head for an Add (blockId null).
  const [visualError, setVisualError] = useState<{
    label: string;
    blockId: string | null;
    message: string;
  } | null>(null);
  // The section whose "Add visual" choices are open. Same home as
  // `editing`, for the same reason: state inside the keyed div dies with
  // the flash remount (a <details> would snap shut the same way).
  const [visualMenu, setVisualMenu] = useState<string | null>(null);
  // Whole-document is the DEFAULT scope (owner directive 2026-08-28): most
  // real instructions span sections, and the per-section "Ask Tron" buttons
  // still narrow it to one.
  const [scope, setScope] = useState<string | null>(DOC_LABEL);
  const [instruction, setInstruction] = useState("");
  // Tron runs independently of drafting: the brain semaphore takes both, a
  // revision only READS until the human accepts, and waiting a 25-minute
  // run to ask for a reword would be absurd.
  const [tronBusy, setTronBusy] = useState(false);
  const [tronFile, setTronFile] = useState<File | null>(null);
  // Tron-originated errors belong beside the Tron controls, not only in the
  // page-level runbar the user is not looking at.
  const [tronError, setTronError] = useState("");
  // Receipt after an accept: on mobile the flash lands in the HIDDEN draft
  // column, so without this the output just vanishes (same reason the gap
  // flow has lastWoven).
  const [tronApplied, setTronApplied] = useState<string | null>(null);
  // Receipt after an accepted REMOVAL: the section is gone, so there is no
  // sheet to flash and no jump target — the pane says so in words.
  const [tronRemoved, setTronRemoved] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{
    label: string;
    proposed: string[];
    current: string[];
    note: string;
    /** Structural proposals riding a single-section revise (§5.17.1):
     *  a replacement header, or removing the section outright. */
    heading: string | null;
    remove: boolean;
  } | null>(null);
  // ---- the whole-document flow (scope === DOC_LABEL) ----
  // One plan turn names the sections to change, then the SAME per-section
  // revise call runs on each, sequentially, collecting proposals here. Each
  // is accepted or discarded exactly like the single proposal above.
  // Structural targets (retitle/remove) skip the revise call: the plan
  // already authored everything they need, so they land as instant entries.
  const [docProposals, setDocProposals] = useState<
    {
      label: string;
      op: "revise" | "retitle" | "remove";
      heading?: string;
      proposed: string[];
      current: string[];
      note: string;
      directive: string;
    }[]
  >([]);
  // The planner's own summary line; also Tron's whole answer when it
  // selects zero sections (a refused or already-satisfied request).
  const [docPlanNote, setDocPlanNote] = useState("");
  const [docRun, setDocRun] = useState<{
    done: number;
    total: number;
    current: string;
  } | null>(null);
  const [docFailures, setDocFailures] = useState<string[]>([]);
  const [docStopped, setDocStopped] = useState(false);
  // Stop was pressed but the in-flight section is still landing; the button
  // acknowledges immediately instead of sitting inert for up to a minute.
  const [docStopping, setDocStopping] = useState(false);
  // Labels accepted from the doc list, for the multi-section receipt.
  const [docApplied, setDocApplied] = useState<string[]>([]);
  // Display names of sections REMOVED from the doc list. Separate from
  // docApplied: a removed section has no sheet to flash and no jump
  // target, and a permanent delete with zero on-screen confirmation is the
  // hidden-column failure the receipts exist to prevent (on mobile the
  // draft column is not even visible when the entry disappears).
  const [docRemoved, setDocRemoved] = useState<string[]>([]);
  // Use-all in flight: per-entry Use this/Discard freeze so a click cannot
  // race the sequential applies into a double accept or a stranded discard.
  const [docAccepting, setDocAccepting] = useState(false);
  // Tron's own stop flag. NOT draftAll's stopRef: the two loops can run at
  // the same time, and a shared flag would make Stop on one kill the other.
  const tronStopRef = useRef(false);
  // Run generation. clearDocFlow bumps it; the doc loop captures it at entry
  // and bails once it moves. Without this, changing the scope mid-run cleared
  // the UI but the loop kept POSTing for up to 40 x ~90s and repopulated the
  // "cleared" proposal list, which is exactly the stale-Use-this hazard the
  // clear exists to prevent.
  const docRunIdRef = useRef(0);
  // What the busy line describes. Keyed on the RUN as started, never on the
  // current select value: changing the scope mid-flight otherwise relabels a
  // live doc run as "Reading the section", which is false.
  const [busyKind, setBusyKind] = useState<"section" | "doc" | null>(null);
  const [notice, setNotice] = useState("");

  // ---- the live-update choreography (governance pattern) ----
  const [highlights, setHighlights] = useState<Set<string>>(new Set());
  // Editing-notes window dismissal (owner directive 2026-09-21): the X on
  // the receipt window hides ONLY the window, never the highlights set,
  // which also drives the per-section "Updated" chips. What is stored is
  // the SIGNATURE of the receipt content at dismissal (the sorted joined
  // highlight labels); the window hides while the current signature equals
  // it, so a merge that adds a section changes the signature and the window
  // returns with the new content. Per-mount state only, never persisted.
  const [receiptDismissedSig, setReceiptDismissedSig] = useState<
    string | null
  >(null);
  const receiptSig = [...highlights].sort().join("\u0000");
  // Dismissal moves focus to the document section landmark (tabIndex -1 on
  // it exists for exactly this) so keyboard and AT users are not dropped on
  // <body> when the X unmounts under them.
  const docPaneRef = useRef<HTMLElement | null>(null);
  // Per-label flash sequence. The keyed div's key reads this map
  // UNCONDITIONALLY, so a key only changes when a NEW flash lands on that
  // label (replaying the wash) — never when the 15s expiry clears the
  // highlight set. Keying off the highlight itself made expiry remount the
  // section, which detached a focused edit textarea mid-sentence and reset
  // the pricing table's horizontal scroll.
  const flashSeq = useRef(new Map<string, number>());
  const flashCounter = useRef(0);

  // ---- draft-all run state ----
  const [run, setRun] = useState<{
    active: boolean;
    done: number;
    total: number;
    /** Display name only; never a reserved label. */
    current: string;
    /** The raw label, for identity checks — a client section titled
     *  "Cover Letter" must not light the letter card's Drafting state. */
    currentLabel: string;
    failures: string[];
    /** The run began with nothing drafted (the first draft of this
     *  response). Fixed at run start, never recomputed per section: the
     *  rail stays hidden for the whole initial run, not just until the
     *  first section lands. */
    initial: boolean;
  } | null>(null);
  const stopRef = useRef(false);
  const revRef = useRef(initialRev);
  // Narration for a run driven by ANOTHER tab (the status route's
  // gen.progress); a returning user must see the run, not a dead button.
  const [followProgress, setFollowProgress] = useState<string | null>(null);
  // Whether a run followed from another tab began with nothing drafted.
  // The status route does not say when its run started, so the mount-time
  // state is the best available signal: busy on load with no section yet
  // means the other tab's run is the initial one. Computed once at mount
  // (a lazy useState, never re-derived: a section landing later must not
  // flip it, that is exactly the mid-run case; a ref read during render
  // would trip react-hooks/refs), and never set.
  const [followInitial] = useState(
    () =>
      initialBusy &&
      initialSections.filter((s) => s.label !== LETTER_LABEL).length === 0
  );
  // True while the mount-time follow loop below is still watching the other
  // tab's run; cleared where that loop gives up or sees it end. Not `busy`
  // (pricing and generate toggle that later) and not followProgress (null
  // in the other tab's gap between sections).
  const [following, setFollowing] = useState(initialBusy);

  // The sticky rail and the section scroll-margins sit BELOW the sticky
  // runbar, whose height varies (notices, wrapping). Measure it into a CSS
  // variable the stylesheet offsets by; without this the two sticky
  // elements share one offset and the runbar covers the rail's tabs.
  const runbarRef = useRef<HTMLDivElement | null>(null);
  // The runbar is ALWAYS sticky now (owner directive 2026-09-30: the
  // drafting status and the Run checks / Word / PDF buttons must never
  // scroll out of view; supersedes the 2026-08-28 scroll-at-rest ruling
  // that pinned it only while a run or notice was live). Its height still
  // varies (notices, archived banner, wrapping), so it is measured into
  // --rfp-runbar-h continuously via the ResizeObserver below. The section
  // workbar IS sticky below md and taller than the old hardcoded 4.5rem,
  // so its real height is measured too.
  // Layout effect, not useEffect: a post-paint first measurement leaves
  // --rfp-runbar-h at 0 for one frame and the sticky bar paints over the
  // rail and receipt.
  useIsoLayoutEffect(() => {
    const el = runbarRef.current;
    const page = el?.closest<HTMLElement>(".rfp-page");
    if (!el || !page) return;
    const apply = () => {
      page.style.setProperty("--rfp-runbar-h", `${el.offsetHeight + 16}px`);
      const wb = document.querySelector<HTMLElement>(".workbar");
      if (wb)
        page.style.setProperty("--rfp-workbar-h", `${wb.offsetHeight}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    const wb = document.querySelector<HTMLElement>(".workbar");
    if (wb) ro.observe(wb);
    window.addEventListener("resize", apply);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", apply);
      page.style.removeProperty("--rfp-runbar-h");
      page.style.removeProperty("--rfp-workbar-h");
    };
  }, []);

  // ---- guided questions ----
  const [answerText, setAnswerText] = useState("");
  // Said when Answer is pressed with nothing to weave. The button stays
  // pressable: a gray Answer read as broken, not as "type first".
  const [answerInvalid, setAnswerInvalid] = useState(false);
  const [remember, setRemember] = useState(true);
  // Receipt for the previous answer. On mobile the flash happens in the
  // HIDDEN draft column, so without this line a 60-90s weave ends with no
  // visible confirmation at all.
  const [lastWoven, setLastWoven] = useState<string | null>(null);
  const [weaving, setWeaving] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  // ---- export ----
  const [exporting, setExporting] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // ---- checks pane: ignore / fix it (§5.17.8) ----
  // The one row whose ignore/restore is in flight (its findingSig); every
  // row's buttons freeze on it because each write replaces the whole stored
  // result, so two in flight would race their setGateResult adoptions.
  const [checksBusySig, setChecksBusySig] = useState<string | null>(null);
  // A failed ignore/restore renders beside ITS row (errors render in the
  // owning pane, the house rule), never as a page notice.
  const [checksError, setChecksError] = useState<{
    sig: string;
    message: string;
  } | null>(null);
  // The ONE open inline context editor (fix recipes with an optional ask);
  // keyed by sig so opening another row's closes this one.
  const [fixAsk, setFixAsk] = useState<{
    sig: string;
    label: string;
    prompt: string;
    text: string;
  } | null>(null);
  // The inline verdict for a pricing/none recipe, keyed to its row.
  const [fixNote, setFixNote] = useState<{
    sig: string;
    message: string;
    pricing: boolean;
  } | null>(null);
  const [ignoredOpen, setIgnoredOpen] = useState(false);

  const covered = new Set(sections.map((s) => s.label));
  const undrafted = structure.filter((n) => !covered.has(n.label));
  // The letter record shares the sections array under its reserved label;
  // every count a person reads must exclude it or "18 of 17" appears.
  const letterSec = sections.find((s) => s.label === LETTER_LABEL) ?? null;
  const draftedCount = sections.filter(
    (s) => s.label !== LETTER_LABEL
  ).length;
  // The rail (Questions / Coverage / Checks / Tron) waits for the document
  // (owner directive 2026-09-30: while the response drafts initially, do
  // not show it; it appears once it can be used, after the draft exists).
  // Hidden while nothing is drafted, and for the whole of a run that began
  // with nothing drafted, so the first landed section does not pop it in
  // mid-run; an explicit ask to see a pane (`railPeek`) overrides BOTH
  // terms: before any draft showPane is unreachable (Run checks is
  // disabled, questions return early, the letter's Ask Tron needs a
  // letter), and once a pane has been asked for it must not vanish under
  // the person when Tron removes the last drafted section. The follow case
  // keys on `following` (the mount-time loop is still watching), not on
  // followProgress, which is null in the other tab's gap between sections
  // and would let the rail flash in and out on the first landed section.
  // A structure-less RFP (form-fill, or a read that failed) keeps the
  // rail: its Coverage list is the only place the found requirements show,
  // and the no-structure copy points there.
  const initialDrafting =
    (run?.active === true && run.initial) || (following && followInitial);
  const railHidden =
    structure.length > 0 &&
    !railPeek &&
    (draftedCount === 0 || initialDrafting);
  // Below lg, a hidden rail means the document is the only view.
  const mobileView = railHidden ? "draft" : mobile;
  // Every section's visual blocks, read ONCE per render through the
  // tolerant reader (stored JSON, never trusted as typed). Reserved records
  // (the letter) never carry blocks.
  const blocksByLabel = new Map<string, DraftBlock[]>(
    sections.map((s) => [
      s.label,
      s.label.startsWith("__")
        ? []
        : sanitizeStoredBlocks(s.blocks, s.paragraphs.length),
    ])
  );
  // The company snapshot belongs on ONE section (the server refuses a
  // second with a 409), so its Add is offered only while no section has it.
  const aboutHeld = [...blocksByLabel.values()].some((bs) =>
    bs.some((b) => b.origin === "about")
  );
  // ISO timestamps compare lexicographically. Gap weaves, Tron accepts, and
  // single-section redrafts all change content under the letter without
  // redrafting it; the hint keeps a stale summary from reading as current.
  const letterStale =
    letterSec !== null &&
    sections.some(
      (s) => s.label !== LETTER_LABEL && s.updatedAt > letterSec.updatedAt
    );

  // Cover and letter furniture date, en-US long form like the export's.
  // Server and viewer can straddle midnight, so the spans carry
  // suppressHydrationWarning.
  const dateLabel = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  // The handoff's content pages set their kicker as "Section 1.1"; RFP
  // structure labels are usually bare ("8", "3.1", "IV") but sometimes
  // arrive already worded, so only prefix when it reads as a bare label.
  // Roman numerals are tested as numerals first: "III" and "VII" contain
  // 3+ letters and would otherwise render bare beside "Section II".
  const secKicker = (label: string) => {
    const t = label.trim();
    if (!t) return "Section";
    if (/^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i.test(t))
      return `Section ${t}`;
    return /[a-z]{3,}/i.test(t) ? t : `Section ${t}`;
  };

  // Gap questions dedupe by normalized text: seventeen sections asking the
  // same certification question is ONE question with seventeen targets, not
  // seventeen interruptions. (The benchmark tool asks a handful for a whole
  // document; the queue must read the same way.) The normalizer is the
  // SHARED one in @/lib/rfp/gaps: the draft route snaps a new gap onto an
  // open question's exact text with the same function, so the two
  // vocabularies cannot drift.
  const gapEntries = new Map<
    string,
    Extract<OpenQuestion, { kind: "gap" }>
  >();
  for (const sec of sections) {
    for (const g of sec.gaps) {
      const norm = normalizeGapQuestion(g.question);
      const existing = gapEntries.get(norm);
      if (existing) {
        if (!existing.targets.some((t) => t.label === sec.label))
          existing.targets.push({
            label: sec.label,
            sectionTitle: sec.title,
            raw: g.question,
          });
      } else {
        gapEntries.set(norm, {
          kind: "gap",
          key: `g:${norm}`,
          targets: [
            { label: sec.label, sectionTitle: sec.title, raw: g.question },
          ],
          text: g.question,
          why: g.why,
        });
      }
    }
  }
  // Props only, so the question and the provenance row read one verdict.
  // No rate card: no floor, no assumption, the plain ask.
  const staffFloor =
    minimumUsers !== null && minimumMonthlyCents !== null
      ? { users: minimumUsers, cents: minimumMonthlyCents }
      : null;
  const staffCtx: StaffContext = {
    evidence: staffEvidence,
    range: staffRange,
    floor: staffFloor,
    assumption: staffFloor ? minimumEvidence : null,
    conflict: staffConflict,
  };
  const queue: OpenQuestion[] = [
    ...pricingQuestions(inputs, statedStaff, staffCtx),
    ...gapEntries.values(),
  ];
  // ONE vocabulary for "question" everywhere on screen: the deduped count.
  // (The raw per-section sum once sat in the Checks pane next to a deduped
  // tab badge, reading as a contradiction.)
  const gapQuestionCount = gapEntries.size;
  const gapSectionCount = sections.filter((s) => s.gaps.length > 0).length;
  const open = queue.filter((q) => !skipped.has(q.key));
  const current = open[0] ?? null;
  const [answeredCount, setAnsweredCount] = useState(0);

  // ---- references (§5.17.2) ----
  // THE references question: the server's canonical text (recognized by its
  // shape, references-question.ts) or a model-worded one the server flagged
  // at load. Its answer carries a third party's name, phone and email, so
  // the remember box is not offered; the gap route refuses to file it
  // whatever is sent.
  const isReferencesQuestion = (question: string) =>
    isCanonicalReferencesQuestion(question) ||
    referencesQuestions.includes(question);
  const currentIsReferences =
    current?.kind === "gap" &&
    current.targets.some((t) => isReferencesQuestion(t.raw));
  // The references question answers through the structured picker
  // (references-picker.tsx). "Answer in words instead" flips THIS question
  // to the textarea; keyed on the question so the next one starts on the
  // picker again without an effect.
  const [refsWordsKey, setRefsWordsKey] = useState<string | null>(null);
  const refsWords = current !== null && refsWordsKey === current.key;
  // Edit after answering (§5.17.10): "Edit references" under a stored
  // references block opens the picker in the Questions pane, seeded with the
  // block's entries; saving replaces that section's card set in place. Shown
  // only while the section still holds a references block (a Remove, or
  // another tab's write, closes it without an effect).
  // Pinned to the block's id, not the label: a Remove followed by a fresh
  // answer puts a NEW block (new id) on the same label, and the stale editor
  // must not take the pane over seeded with the removed entries.
  const [refsEdit, setRefsEdit] = useState<{
    label: string;
    blockId: string;
    entries: ReferenceEntry[];
  } | null>(null);
  const refsEditing =
    refsEdit !== null &&
    proposalId !== null &&
    (blocksByLabel.get(refsEdit.label) ?? []).some(
      (b) => b.kind === "references" && b.id === refsEdit.blockId
    )
      ? refsEdit
      : null;
  // How many references the open question names, for the picker's
  // "The RFP asks for M." line. Read from the canonical wording only
  // (references-ask.ts REFERENCES_GAP_QUESTION); a model-worded question
  // gives null and the line is not shown.
  const refsAsked = currentIsReferences
    ? referencesAskedCount(current?.text ?? "")
    : null;
  // A draft that predates the references backstop: the RFP asks, the draft
  // lists none, and no question is open. Server-computed at load; cleared
  // once the question is added, and quiet as soon as any section carries the
  // question (a redraft's backstop adds it without this list knowing). NOT a
  // question: never in the queue, never in the open count.
  const [refsMissing, setRefsMissing] = useState(initialRefsMissing);
  const [refsBusy, setRefsBusy] = useState(false);
  const [refsError, setRefsError] = useState("");
  const refsPrompt =
    refsMissing.length > 0 &&
    proposalId !== null &&
    sections.length > 0 &&
    !sections.some((s) => s.referencesAnswered) &&
    !sections.some((s) => s.gaps.some((g) => isReferencesQuestion(g.question)))
      ? refsMissing[0]
      : null;

  /**
   * Flash + rail a set of section panels, then scroll the first into view.
   * Never scrolls while the user is typing: a section landing mid-run must
   * not yank the viewport away from a textarea (the governance builder's
   * "the user may be typing" rule, applied to the window).
   */
  const jumpTo = useCallback((label: string) => {
    const el = document.getElementById(
      label === "__pricing" ? "sec-__pricing" : `sec-${label}`
    );
    if (!el) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    // The document scrolls WITH the window at every width (owner directive
    // 2026-08-28: the self-scrolling pane was one vertical scrollbar too
    // many); the sec-* scroll-margins in globals.css clear the sticky bars.
    // showChanged still refuses to jump while the user is typing.
    el.scrollIntoView({
      block: "start",
      behavior: reduce ? "auto" : "smooth",
    });
  }, []);

  // "Updated just now" must stay true: the receipt and the section chips
  // expire on a timer instead of sitting there until the next change.
  const highlightTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (highlightTimer.current !== null)
        window.clearTimeout(highlightTimer.current);
    },
    []
  );
  const showChanged = useCallback(
    (labels: string[], opts: { jump?: boolean } = {}) => {
      if (!labels.length) return;
      // A landed change supersedes a visual failure notice on that section
      // (the notice would otherwise outlive the block it named).
      setVisualError((prev) =>
        prev && labels.includes(prev.label) ? null : prev
      );
      // MERGE, don't replace: one answer can weave into several sections
      // over 60-90s each, and draft-all lands sections one poll at a time.
      // Replacing made the receipt name only the LAST section of a
      // multi-target change. Everything merged clears together, 15s after
      // the latest change, which is what "just now" means.
      setHighlights((prev) => new Set([...prev, ...labels]));
      flashCounter.current += 1;
      for (const l of labels) flashSeq.current.set(l, flashCounter.current);
      if (highlightTimer.current !== null)
        window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => {
        setHighlights(new Set());
        // Expiry forgets the window dismissal with the set, so the NEXT
        // receipt always shows even when it happens to name exactly the
        // sections the dismissed one did.
        setReceiptDismissedSig(null);
        highlightTimer.current = null;
      }, 15000);
      const typing = ["TEXTAREA", "INPUT"].includes(
        document.activeElement?.tagName ?? ""
      );
      // jump: false is a change made in place (a visual added or removed
      // under the section the person is looking at): the receipt and the
      // chip still land, the viewport stays where the press happened.
      if (typing || opts.jump === false) return;
      window.setTimeout(() => jumpTo(labels[0]), 60);
    },
    [jumpTo]
  );

  /**
   * One poll of the document status; applies fresh sections when rev moved.
   * `reachable: false` means TRANSPORT failure (network blip, 5xx, expired
   * session), which must never read as "the run finished" — that misread
   * once made draftAll move on mid-section and 409-cascade through every
   * remaining one.
   */
  const pollOnce = useCallback(async (): Promise<{
    reachable: boolean;
    inFlight: boolean;
    progress?: string | null;
    error: string | null;
    changed: string[];
  }> => {
    const s = await fetch(
      `/api/rfp/documents/${documentId}/status?rev=${revRef.current}`,
      { cache: "no-store" }
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!s)
      return { reachable: false, inFlight: true, error: null, changed: [] };
    if (!s.proposal)
      return { reachable: true, inFlight: false, error: null, changed: [] };
    const p = s.proposal;
    let changed: string[] = [];
    if (Array.isArray(p.sections)) {
      const next: Section[] = p.sections;
      const prev = sectionsRef.current;
      changed = next
        .filter((n) => {
          const old = prev.find((o) => o.label === n.label);
          return !old || old.updatedAt !== n.updatedAt;
        })
        .map((n) => n.label);
      setSections(next);
      // Adopt the document structure alongside the sections: a retitle or
      // remove accepted in ANOTHER tab moves both, and stale structure here
      // would render the old header as a ghost "Not drafted yet" sheet
      // while hiding the renamed section entirely. (The route serves the
      // full structure on every poll; requirements travel only as a count,
      // so Coverage rows heal on reload instead.)
      if (Array.isArray(s.structure)) setStructure(s.structure);
      if (p.pricing !== undefined) setPricing(p.pricing);
      if (p.pricingInputs) {
        // Adopt provenance with the inputs: a second tab that edited the
        // count must retire this tab's "From the RFP" reading on poll, not
        // on reload.
        setInputs(parseQuoteInputs(p.pricingInputs));
        setFmuSource(parseInputsSource(p.pricingInputs));
      }
      revRef.current = p.rev;
      setProposalId(p.id);
    }
    return {
      reachable: true,
      inFlight: Boolean(p.gen?.inFlight),
      progress: typeof p.gen?.progress === "string" ? p.gen.progress : null,
      error: p.gen?.error ?? null,
      changed,
    };
  }, [documentId, setSections]);

  /**
   * Adopt a mutation response's rev ONLY when it is exactly the next one:
   * then this client provably saw everything below it. Fast-forwarding past
   * unseen revs made the rev-gated poll withhold sections this tab never
   * fetched (the last section of a run could stay invisible until reload).
   */
  const adoptRev = useCallback((rev: unknown) => {
    if (typeof rev === "number" && rev === revRef.current + 1)
      revRef.current = rev;
  }, []);

  /** Draft one section: 202 then poll to completion. `force` is the letter
   *  redraft button's explicit consent to replace a hand-edited letter. */
  const draftOne = useCallback(
    async (
      label: string,
      title: string,
      force = false
    ): Promise<{ error: string | null; busy: boolean }> => {
      // Every fetch in this file goes through a rejection guard: an
      // unhandled rejection here would unwind draftAll past its cleanup and
      // freeze the workbar on "Drafting" forever.
      const res = await fetch(`/api/rfp/documents/${documentId}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sectionLabel: label, sectionTitle: title, force }),
      }).catch(() => null);
      if (!res)
        return { error: "The server could not be reached.", busy: false };
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        return {
          error: d?.message ?? "That section could not be drafted.",
          // Only a real claim conflict stops a draft-all run; the letter's
          // own 409s (not_ready, human_letter) are per-target failures, and
          // reading them as busy produced a false "another draft is already
          // running" notice.
          busy: res.status === 409 && d?.error === "busy",
        };
      }
      // One section measured 28-90s. Poll the PROPOSAL's gen state (the old
      // code watched doc.status, which never says "drafting", and gave up
      // after one tick). Transport failures do not end the wait; only a
      // REACHABLE idle answer does, with a tolerance of 10 consecutive
      // failed polls (~30s of outage) before giving up.
      let unreachable = 0;
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const st = await pollOnce();
        if (!st.reachable) {
          unreachable += 1;
          if (unreachable >= 10)
            return {
              error:
                "Lost contact with the server while drafting. Reload to catch up; the draft continues server-side.",
              busy: false,
            };
          continue;
        }
        unreachable = 0;
        if (st.changed.length) showChanged(st.changed);
        if (!st.inFlight) return { error: st.error, busy: false };
      }
      return { error: "Timed out waiting for the draft.", busy: false };
    },
    [documentId, pollOnce, showChanged]
  );

  /** The CoWork loop: every undrafted section, one call at a time, and the
   *  cover letter LAST (owner directive 2026-08-02): it is the high-level
   *  summary of the finished response, and drafted first it had nothing to
   *  summarize. Any run that lands a section redrafts it so it never
   *  summarizes a document newer than itself; a human-edited letter is never
   *  overwritten by the loop. */
  const draftAll = useCallback(async () => {
    const remaining = structure.filter(
      (n) => !sections.some((s) => s.label === n.label)
    );
    const letterRec = sections.find((s) => s.label === LETTER_LABEL);
    const draftedNow = sections.filter(
      (s) => s.label !== LETTER_LABEL
    ).length;
    const letterAtEnd =
      (remaining.length > 0 || draftedNow > 0) &&
      letterRec?.generatedBy !== "human" &&
      (remaining.length > 0 || !letterRec);
    if (!remaining.length && !letterAtEnd) return;
    const targets = [
      ...remaining,
      ...(letterAtEnd ? [{ label: LETTER_LABEL, title: LETTER_TITLE }] : []),
    ];
    stopRef.current = false;
    setBusy(true);
    setNotice("");
    // Read once, before the loop: this is the run's identity for the
    // hidden rail, and per-section state would flip it as sections land.
    const initial =
      sectionsRef.current.filter((s) => s.label !== LETTER_LABEL).length ===
      0;
    const failures: string[] = [];
    let stoppedByBusy = false;
    for (let i = 0; i < targets.length; i++) {
      if (stopRef.current) break;
      const node = targets[i];
      // The letter guard re-checks LIVE state at its turn, not the closure
      // from click time: an edit made while section 9 of 17 was drafting
      // stamped the letter human, and the loop must honor that. The server
      // enforces the same rule; this skip just avoids a noisy failure line.
      if (
        node.label === LETTER_LABEL &&
        sectionsRef.current.find((s) => s.label === LETTER_LABEL)
          ?.generatedBy === "human"
      )
        continue;
      const display =
        node.label === LETTER_LABEL
          ? LETTER_TITLE
          : `${node.label} ${node.title}`.trim();
      setRun({
        active: true,
        done: i,
        total: targets.length,
        current: display,
        currentLabel: node.label,
        failures,
        initial,
      });
      const { error: err, busy: wasBusy } = await draftOne(
        node.label,
        node.title
      );
      // A busy 409 means SOMETHING ELSE holds the claim (another tab, or a
      // poll misread) — continuing would 409 every remaining section in
      // seconds. Stop the loop; it is not a per-section failure.
      if (wasBusy) {
        stoppedByBusy = true;
        break;
      }
      if (err) failures.push(`${display}: ${err}`);
    }
    setRun((r) =>
      r ? { ...r, active: false, done: r.total, failures } : null
    );
    setBusy(false);
    if (stoppedByBusy)
      setNotice(
        `Stopped: another draft is already running on this RFP.${failures.length ? ` ${failures.length} section${failures.length === 1 ? "" : "s"} did not draft.` : ""}`
      );
    else if (failures.length)
      setNotice(
        `${failures.length} section${failures.length === 1 ? "" : "s"} did not draft. Use “Draft this” on them to retry.`
      );
    else setRun(null);
    // The drafted document now knows its open questions; put them in front.
    setPane("questions");
  }, [structure, sections, draftOne]);

  // Auto-start after ingest handoff (?draft=all), once, then drop the param
  // so a reload does not re-trigger it.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoDraft || autoRan.current) return;
    autoRan.current = true;
    router.replace(`/rfp/r/${documentId}`, { scroll: false });
    // Deferred a tick: the run mutates state, and the repo's pattern for
    // view-following work inside an effect is setTimeout(..., 0).
    if (structure.length > 0 && sections.length === 0)
      window.setTimeout(() => void draftAll(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDraft]);

  // If the server said a draft is in flight (another tab, or a reload
  // mid-run), follow it to completion instead of sitting on a dead button.
  // TWO consecutive reachable-idle polls are required before declaring the
  // run over: another tab's draft-all has a real idle gap of up to ~3s
  // between sections, and one poll landing in it would re-enable the button
  // mid-run. Runs for up to 30 minutes (a 17-section run is ~25), and on
  // exhaustion CLEARS busy with a notice rather than freezing the buttons.
  useEffect(() => {
    if (!initialBusy) return;
    let alive = true;
    (async () => {
      let idleStreak = 0;
      for (let i = 0; i < 600 && alive; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const st = await pollOnce();
        if (st.changed.length) showChanged(st.changed);
        if (!st.reachable) continue;
        if (st.inFlight) {
          idleStreak = 0;
          if (alive) setFollowProgress(st.progress ?? "a section");
          continue;
        }
        idleStreak += 1;
        if (idleStreak >= 2) {
          if (alive) {
            setBusy(false);
            setFollowProgress(null);
            setFollowing(false);
          }
          return;
        }
      }
      if (alive) {
        setBusy(false);
        setFollowProgress(null);
        setFollowing(false);
        setNotice(
          "Stopped following a draft run happening elsewhere. Reload to catch up."
        );
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate(label: string, title: string, force = false) {
    setBusy(true);
    setNotice("");
    setRun({
      active: true,
      done: 0,
      total: 1,
      // Same display mapping as draftAll: the reserved label must never
      // surface in the runbar, and the letter card's Drafting state keys
      // on currentLabel.
      current:
        label === LETTER_LABEL ? LETTER_TITLE : `${label} ${title}`.trim(),
      currentLabel: label,
      failures: [],
      initial:
        sectionsRef.current.filter((s) => s.label !== LETTER_LABEL)
          .length === 0,
    });
    const { error: err } = await draftOne(label, title, force);
    setRun(null);
    setBusy(false);
    if (err) setNotice(err);
  }

  /** Answer the current pricing question: instant, no brain. */
  async function answerPricing(
    q: Extract<OpenQuestion, { kind: "pricing" }>,
    value: number | string | boolean,
    extra: Partial<QuoteInputs> = {}
  ) {
    if (!proposalId) {
      setNotice("Draft at least one section first, so there is a proposal to price.");
      return;
    }
    const next: QuoteInputs = { ...inputs, ...extra, [q.field]: value };
    setBusy(true);
    const res = await fetch(`/api/rfp/proposals/${proposalId}/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    }).catch(() => null);
    setBusy(false);
    if (!res) {
      setNotice("The server could not be reached. Nothing was saved.");
      return;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.message ?? "That answer was not saved.");
      return;
    }
    const d = await res.json();
    // The SERVER's inputs-and-provenance verdict wins over the local next:
    // provenance ("From the RFP") is route-derived, and mirroring the flip
    // here could disagree with what actually persisted.
    if (d.inputs) {
      setInputs(parseQuoteInputs(d.inputs));
      setFmuSource(parseInputsSource(d.inputs));
    } else {
      setInputs(next);
    }
    setPricing(d.quote ?? null);
    adoptRev(d.rev);
    setGateResult(null);
    setAnsweredCount((n) => n + 1);
    setAnswerText("");
    if (d.quote) showChanged(["__pricing"]);
  }

  /**
   * Answer the current gap question. One answer, EVERY section holding the
   * question: the weave runs per target (each is a 60-90s brain call, so
   * progress is narrated per section), and a single failure stops the loop
   * with the remaining targets still queued.
   */
  const [weaveProgress, setWeaveProgress] = useState<string | null>(null);
  // Questions whose answer already filed a knowledge row: a RETRY after a
  // partial failure must not file a duplicate.
  const rememberedRef = useRef<Set<string>>(new Set());
  async function answerGap(q: Extract<OpenQuestion, { kind: "gap" }>) {
    if (!proposalId || answerText.trim().length < 2) return;
    setWeaving(q.key);
    setNotice("");
    const done: string[] = [];
    // remember=true only files the knowledge row once; repeating it per
    // section (or per retry) would create duplicate proposals.
    // A references answer is never remembered (third-party contact
    // details); the server enforces it, this keeps the request honest.
    let rememberThis =
      remember &&
      !q.targets.some((t) => isReferencesQuestion(t.raw)) &&
      !rememberedRef.current.has(q.key);
    for (let i = 0; i < q.targets.length; i++) {
      const target = q.targets[i];
      setWeaveProgress(
        q.targets.length > 1
          ? `${target.label} · ${i + 1} of ${q.targets.length}`
          : target.label
      );
      const res = await fetch(`/api/rfp/proposals/${proposalId}/gap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: target.label,
          question: target.raw,
          answer: answerText.trim(),
          remember: rememberThis,
        }),
      }).catch(() => null);
      if (rememberThis) rememberedRef.current.add(q.key);
      rememberThis = false;
      if (!res) {
        // The weave is a long synchronous call; the edge can close the
        // connection while the server still lands the write. Check before
        // claiming failure.
        const st = await pollOnce();
        if (st.changed.length) {
          showChanged(st.changed);
          done.push(target.label);
          continue;
        }
        setNotice(
          "The connection dropped while weaving. The answer may still land; reload in a minute if the section does not update."
        );
        break;
      }
      if (!res.ok) {
        // 404 "no longer open" = this target was ALREADY woven (an earlier
        // partial run, or another tab). That is completion, not failure.
        if (res.status === 404) {
          done.push(target.label);
          continue;
        }
        const d = await res.json().catch(() => null);
        setNotice(d?.message ?? "The answer could not be woven in.");
        break;
      }
      const d = await res.json();
      setSections((prev) =>
        prev.map((s) => (s.label === target.label ? d.section : s))
      );
      adoptRev(d.rev);
      setGateResult(null);
      done.push(target.label);
      showChanged([target.label]);
      if (d.note && q.targets.length === 1) setNotice(d.note);
      // The box was checked on a references question this client did not
      // recognize (older model wording): say what the server did.
      else if (d.rememberedSkipped === "references")
        setNotice("Reference contacts are not kept for future RFPs.");
    }
    setWeaving(null);
    setWeaveProgress(null);
    if (done.length === q.targets.length) {
      setAnsweredCount((n) => n + 1);
      setAnswerText("");
      setLastWoven(done.join(", "));
    }
  }

  /**
   * Add the references question to a draft that dropped the RFP's ask
   * (POST .../references-gap: no brain call, idempotent). The response
   * carries the whole sections array; it is adopted like any other
   * sections-returning write (rev, stale gate verdict).
   */
  async function addReferencesQuestion() {
    if (!proposalId || refsBusy) return;
    setRefsBusy(true);
    setRefsError("");
    const res = await fetch(
      `/api/rfp/proposals/${proposalId}/references-gap`,
      { method: "POST" }
    ).catch(() => null);
    setRefsBusy(false);
    if (!res) {
      setRefsError("The server could not be reached. Nothing was added.");
      return;
    }
    const d = await res.json().catch(() => null);
    if (!res.ok || !d || !Array.isArray(d.sections)) {
      setRefsError(d?.message ?? "The question could not be added.");
      return;
    }
    setSections(d.sections);
    adoptRev(d.rev);
    const added: string[] = Array.isArray(d.added) ? d.added : [];
    if (added.length) {
      setGateResult(null);
      showChanged(added);
    }
    setRefsMissing([]);
  }

  async function runChecks(): Promise<GateResult | null> {
    // Never mid ignore/restore: the buttons are disabled on checksBusySig for
    // the same reason, but the export path can also call this, so the guard
    // lives here too.
    if (!proposalId || checksBusySig !== null) return null;
    setChecking(true);
    const res = await fetch(`/api/rfp/proposals/${proposalId}/gate`, {
      method: "POST",
    }).catch(() => null);
    setChecking(false);
    if (!res) {
      setNotice("The server could not be reached.");
      return null;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.message ?? "The checks could not run.");
      return null;
    }
    const result: GateResult = await res.json();
    setGateResult(result);
    return result;
  }

  /** POST one ignore/restore to the checks route. The server re-validates
   *  the sig against the stored run under a row lock and answers with the
   *  UPDATED stored GateResult, adopted directly (same shape as runChecks),
   *  so the row moves between the lists with no extra fetch. */
  async function postChecksOp(op: "ignore" | "restore", sig: string) {
    if (!proposalId || checksBusySig) return;
    setChecksBusySig(sig);
    setChecksError(null);
    const res = await fetch(`/api/rfp/proposals/${proposalId}/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, sig }),
    }).catch(() => null);
    setChecksBusySig(null);
    if (!res) {
      setChecksError({
        sig,
        message: "The server could not be reached. Nothing was changed.",
      });
      return;
    }
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      setChecksError({
        sig,
        message: d?.message ?? "That finding could not be changed.",
      });
      return;
    }
    setGateResult(d as GateResult);
    if (fixAsk?.sig === sig) setFixAsk(null);
    if (fixNote?.sig === sig) setFixNote(null);
  }

  /** Fire a Tron revision from a Checks-pane fix: the SAME clears as picking
   *  the scope by hand (the standing rule: every route that changes the Tron
   *  scope runs pickScope), then the ask flow with EXPLICIT args, and the
   *  instruction mirrored into the pane so what was asked is visible. The
   *  explicit args matter: setInstruction has not landed when askTron reads
   *  state, so the payload must not depend on it. */
  function runFix(label: string, instr: string) {
    pickScope(label);
    setInstruction(instr);
    void askTron({ label, instruction: instr });
  }

  /** The Fix it button: resolve the finding's recipe and act on it. */
  function fixIt(v: Violation, sig: string) {
    setChecksError(null);
    const r = fixRecipe(v, { sections, requirements });
    if (r.kind === "tron") {
      if (r.ask) {
        const prompt = r.ask.prompt;
        setFixNote(null);
        // Toggle: pressing Fix it again on the open row closes the editor.
        setFixAsk((cur) =>
          cur?.sig === sig ? null : { sig, label: r.label, prompt, text: "" }
        );
        return;
      }
      setFixAsk(null);
      runFix(r.label, r.instruction);
      return;
    }
    if (r.kind === "redraft") {
      // The EXISTING per-section redraft path (the section card's Redraft
      // button calls exactly this): generate with force replaces the section
      // wholesale, which is rule C1's own remedy (rebuild, do not patch).
      setFixAsk(null);
      const node = structure.find((n) => n.label === r.label);
      const sec = sections.find((s) => s.label === r.label);
      void generate(r.label, node?.title ?? sec?.title ?? r.label, true);
      return;
    }
    setFixAsk(null);
    setFixNote({ sig, message: r.message, pricing: r.kind === "pricing" });
  }

  async function exportAs(format: "docx" | "pdf") {
    if (!proposalId) return;
    setExporting(format);
    setNotice("");
    const res = await fetch(
      `/api/rfp/proposals/${proposalId}/export?format=${format}`
    ).catch(() => null);
    setExporting(null);
    if (!res) {
      setNotice("The server could not be reached.");
      return;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.message ?? "The export failed.");
      return;
    }
    const blob = await res.blob();
    const dispo = res.headers.get("content-disposition") ?? "";
    const name =
      /filename="([^"]+)"/.exec(dispo)?.[1] ?? `rfp-response.${format}`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    // The current state always downloads, unmarked (owner directive
    // 2026-08-28: the file must never say DRAFT anywhere). What is still
    // outstanding is said HERE instead, so finishing it is one glance away.
    if (res.headers.get("x-rfp-draft") === "1") {
      const gaps = Number(res.headers.get("x-rfp-open-gaps") ?? "0");
      const missing = Number(res.headers.get("x-rfp-pricing-missing") ?? "0");
      const gateOk = res.headers.get("x-rfp-gate-passed") === "1";
      const parts: string[] = [];
      // The header counts raw per-section gaps; the screen speaks in deduped
      // questions, so prefer the client's own count when it has one.
      const qCount = gapQuestionCount > 0 ? gapQuestionCount : gaps;
      if (gaps > 0)
        parts.push(`${qCount} open question${qCount === 1 ? "" : "s"}`);
      if (missing > 0)
        parts.push(`${missing} pricing answer${missing === 1 ? "" : "s"}`);
      if (!gateOk) parts.push("failing checks");
      setNotice(
        `Downloaded. Still outstanding: ${parts.join(", ") || "unresolved items"}. The Questions and Checks panes walk through them.`
      );
      // The export just ran and stored a gate result; without this the notice
      // can say "failing checks" while the Checks pane still shows nothing.
      if (!gateOk) void runChecks();
    }
  }

  async function saveEdit(label: string) {
    if (!proposalId) return;
    // The SAME caps the PATCH applies server-side. Without them a 13th
    // paragraph is silently dropped on the server while the client keeps it,
    // and because adoptRev advances past that write the rev-gated poll never
    // re-sends sections — the divergence never heals, and Tron's staleness
    // guard then refuses every proposal on that section forever.
    const paragraphs = editText
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((p) => p.slice(0, 4000));
    const res = await fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, paragraphs }),
    }).catch(() => null);
    if (!res) {
      setNotice("The server could not be reached. Nothing was saved.");
      return;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.message ?? "That edit was not saved.");
      return;
    }
    const d = await res.json().catch(() => null);
    adoptRev(d?.rev);
    setGateResult(null);
    setSections((prev) =>
      prev.map((s) => (s.label === label ? { ...s, paragraphs } : s))
    );
    setEditing(null);
    setNotice("");
  }

  /**
   * Add a server-built visual to a section, or remove one block (PATCH
   * .../section, op "visuals"). No brain call: the server rebuilds from the
   * live facts, so nothing but the action (and a block id) is sent. The
   * response is adopted like every other sections-returning write: rev,
   * stale gate verdict, then showChanged for the flash and the receipt.
   */
  async function changeVisual(
    label: string,
    action: VisualAction | "remove",
    blockId?: string
  ) {
    if (!proposalId || visualBusy) return;
    setVisualMenu(null);
    setVisualBusy(`${label}\u0000${action}\u0000${blockId ?? ""}`);
    setVisualError(null);
    const fail = (message: string) =>
      setVisualError({ label, blockId: blockId ?? null, message });
    const res = await fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label,
        op: "visuals",
        action,
        ...(blockId ? { blockId } : {}),
      }),
    }).catch(() => null);
    if (!res) {
      // The connection dropped: the write may still have landed. One poll
      // says so, and a landed change shows as one instead of failing.
      const st = await pollOnce();
      setVisualBusy(null);
      if (st.changed.length) {
        showChanged(st.changed, { jump: false });
        return;
      }
      fail("The connection dropped. Reload if the visual did not change.");
      return;
    }
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      // 404 (the block is already gone) and 409 (the draft moved under
      // this tab, or the snapshot lives elsewhere): adopt the current
      // sections first, so the notice sits beside what is actually there
      // and never tells the person to reload for what the poll just did.
      if (res.status === 404 || res.status === 409) await pollOnce();
      setVisualBusy(null);
      const serverText =
        typeof d?.message === "string"
          ? d.message.replace(/\s*Reload\b[^.]*\.?\s*$/, "").trim()
          : "";
      fail(
        res.status === 404
          ? "That visual was already removed."
          : serverText ||
              (action === "remove"
                ? "That visual was not removed."
                : "That visual was not added.")
      );
      return;
    }
    if (Array.isArray(d?.sections)) {
      setSections(d.sections);
      adoptRev(d.rev);
    } else if (d?.section && typeof d.section.label === "string") {
      const next: Section = d.section;
      setSections((prev) => prev.map((s) => (s.label === label ? next : s)));
      adoptRev(d.rev);
    } else {
      // The write landed but the response carried no sections. The rev is
      // deliberately NOT adopted, so the rev-gated poll fetches them.
      await pollOnce();
    }
    // Released only once the sections are adopted: freed earlier, a second
    // press could race the adoption with a stale rev.
    setVisualBusy(null);
    setGateResult(null);
    // No jump: the person pressed Add or Remove right here, and a Remove
    // under the sixth block would otherwise yank the viewport to the head.
    showChanged([label], { jump: false });
  }

  /** How a human reads a section reference anywhere in the Tron pane.
   *  Reads the `sections` STATE, not sectionsRef: it renders, and a ref
   *  read during render is the exact staleness the ref exists to avoid. */
  const tronDisplay = (label: string) => {
    if (label === LETTER_LABEL) return LETTER_TITLE;
    const sec = sections.find((s) => s.label === label);
    return sec ? `${sec.label} ${sec.title}`.trim() : label;
  };

  /** Every doc-flow surface, back to blank. A stale plan with a live "Use
   *  this" invites a wrong write, same reason the single proposal clears. */
  const clearDocFlow = () => {
    // Invalidate any live doc loop FIRST: clearing the surfaces without
    // detaching the loop let it repopulate them from in-flight responses.
    docRunIdRef.current += 1;
    setDocProposals([]);
    setDocPlanNote("");
    setDocRun(null);
    setDocFailures([]);
    setDocStopped(false);
    setDocStopping(false);
    setDocApplied([]);
    setDocRemoved([]);
  };

  /** EVERY route that changes the Tron scope runs the same clears as the
   *  select's onChange: the per-section "Ask Tron" buttons used to only
   *  setScope, leaving a full set of whole-document cards (with a live
   *  "Use all") on screen under a now-single-section scope — the exact
   *  stale-Use-this hazard the select guards against. */
  const pickScope = (label: string) => {
    setScope(label);
    setProposal(null);
    setTronError("");
    setTronApplied(null);
    setTronRemoved(null);
    clearDocFlow();
    showPane("tron");
  };

  /** One Tron POST, JSON or multipart depending on the attached file. The
   *  file is re-sent per call: "align each section with the attached
   *  document" needs the content at revise time, not only at plan time. */
  const postTron = (payload: {
    label: string;
    instruction: string;
    directive?: string;
  }): Promise<Response | null> => {
    if (tronFile) {
      const form = new FormData();
      form.set("label", payload.label);
      form.set("instruction", payload.instruction);
      if (payload.directive) form.set("directive", payload.directive);
      form.set("file", tronFile);
      return fetch(`/api/rfp/proposals/${proposalId}/section`, {
        method: "POST",
        body: form,
      }).catch(() => null);
    }
    return fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
  };

  /** Overrides exist for the Checks pane's Fix it (runFix): it pickScopes
   *  and setInstructions in the same tick, so neither state has landed when
   *  this reads it — the payload label/instruction must arrive explicitly or
   *  the run would use the PREVIOUS scope and instruction. With no overrides
   *  the pane's own button behavior is unchanged. */
  async function askTron(overrides?: { label?: string; instruction?: string }) {
    const target = overrides?.label ?? scope;
    const instr = overrides?.instruction ?? instruction;
    if (!proposalId || !target || instr.trim().length < 3) return;
    setTronBusy(true);
    setBusyKind(target === DOC_LABEL ? "doc" : "section");
    setNotice("");
    setTronError("");
    setTronApplied(null);
    setTronRemoved(null);
    // A new request supersedes the open proposal; leaving it on screen with
    // a live "Use this" invites accepting section A's old text while B is
    // in flight. The doc flow's collected proposals clear for the same
    // reason.
    setProposal(null);
    clearDocFlow();
    if (target === DOC_LABEL) {
      await askTronDoc(instr);
      return;
    }
    const res = await postTron({ label: target, instruction: instr });
    setTronBusy(false);
    setBusyKind(null);
    if (!res) {
      setTronError("The server could not be reached. Nothing has been changed.");
      return;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setTronError(
        d?.message ?? "Tron did not answer. Nothing has been changed."
      );
      return;
    }
    const d = await res.json();
    // The proposal renders right HERE in the Tron pane; accepting it is
    // what flashes the section.
    setProposal({
      label: target,
      proposed: d.proposed,
      current: d.current,
      note: d.note,
      heading: typeof d.heading === "string" && d.heading ? d.heading : null,
      remove: d.remove === true,
    });
  }

  /** The whole-document flow: one PLAN turn names the sections to change,
   *  then the targets loop through the EXISTING per-section revise call,
   *  one at a time (never parallel: the brain semaphore has 2 slots shared
   *  with Twilio voice), same client-driven pattern as draftAll. Nothing is
   *  written; every proposal still waits for its own accept. */
  // The instruction arrives as a PARAMETER, never read from state: askTron
  // passes what it validated, and the Checks-pane fix flow sets the state in
  // the same tick it asks (the setState race the explicit arg avoids).
  async function askTronDoc(instr: string) {
    tronStopRef.current = false;
    // Captured AFTER askTron's clearDocFlow bump. Once the ref moves again
    // (scope change, another clear), this run is abandoned: no more POSTs,
    // no more writes to the doc surfaces. Only stale() may end the run with
    // the surfaces untouched, and it may clear tronBusy because a NEW ask
    // cannot start while the button is disabled on tronBusy.
    const runId = docRunIdRef.current;
    const stale = () => docRunIdRef.current !== runId;
    const res = await postTron({ label: DOC_LABEL, instruction: instr });
    if (stale()) {
      setTronBusy(false);
      setBusyKind(null);
      return;
    }
    if (!res) {
      setTronBusy(false);
      setBusyKind(null);
      setTronError("The server could not be reached. Nothing has been changed.");
      return;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setTronBusy(false);
      setBusyKind(null);
      setTronError(
        d?.message ?? "Tron did not answer. Nothing has been changed."
      );
      return;
    }
    const d = await res.json().catch(() => null);
    const targets: {
      label: string;
      op?: "revise" | "retitle" | "remove";
      directive: string;
      heading?: string;
    }[] = Array.isArray(d?.plan?.targets) ? d.plan.targets : [];
    const note = typeof d?.plan?.note === "string" ? d.plan.note : "";
    if (targets.length === 0) {
      // Zero targets is Tron's ANSWER (nothing to change, or a request it
      // must refuse), not a failure; it renders as the plan note.
      setTronBusy(false);
      setBusyKind(null);
      setDocPlanNote(
        note || "Tron found nothing to change for that request."
      );
      return;
    }
    setDocPlanNote(note);
    const failures: string[] = [];
    // The progress line narrates only the targets that COST a call:
    // structural entries land instantly, and counting them once flashed
    // "(3 of 3)" as the first thing the user saw.
    const reviseTotal = targets.filter(
      (t) => t.op !== "retitle" && t.op !== "remove"
    ).length;
    // Counts sections actually sent, not loop index: a section deleted
    // since the plan is skipped, and "(3 of 7)" jumping to "(5 of 7)"
    // reads as a lost response.
    let attempted = 0;
    for (let i = 0; i < targets.length; i++) {
      // A stale run is ABANDONED: return without touching the surfaces
      // (clearDocFlow already reset them, and the old `break` fell through
      // to the tail, which wrote the dead run's failures back onto the
      // cleared pane). A stopped run breaks so the tail reports honestly.
      if (stale()) {
        setTronBusy(false);
        setBusyKind(null);
        return;
      }
      if (tronStopRef.current) break;
      const t = targets[i];
      // The plan read a snapshot; a section deleted since then (another
      // tab's redraft) just drops out of the run.
      const live = sectionsRef.current.find((s) => s.label === t.label);
      if (!live) continue;
      // Structural targets need no revise call: the plan already authored
      // the heading (retitle) or the decision (remove). They land as
      // instant proposals BEFORE the progress line ticks; every write
      // still waits for Use this.
      if (t.op === "retitle" || t.op === "remove") {
        if (t.op === "retitle" && !t.heading) continue;
        setDocProposals((prev) => [
          ...prev,
          {
            label: t.label,
            op: t.op as "retitle" | "remove",
            ...(t.op === "retitle" ? { heading: t.heading } : {}),
            proposed: [],
            current: live.paragraphs,
            note: "",
            directive: t.directive,
          },
        ]);
        continue;
      }
      const display =
        live.label === LETTER_LABEL
          ? LETTER_TITLE
          : `${live.label} ${live.title}`.trim();
      setDocRun({ done: attempted, total: reviseTotal, current: display });
      attempted++;
      const r = await postTron({
        label: t.label,
        instruction: instr,
        directive: t.directive,
      });
      if (stale()) {
        setTronBusy(false);
        setBusyKind(null);
        return;
      }
      if (!r || !r.ok) {
        const rd = r ? await r.json().catch(() => null) : null;
        failures.push(
          `${display}: ${
            rd?.message ??
            (r
              ? "Tron did not return a revision."
              : "The server could not be reached.")
          }`
        );
        continue;
      }
      const rd = await r.json().catch(() => null);
      if (!rd || !Array.isArray(rd.proposed)) {
        failures.push(`${display}: Tron did not return a revision.`);
        continue;
      }
      // Pushed AS IT ARRIVES: the user reads early proposals while later
      // sections are still thinking. A revise answer can still carry a
      // structural half (the model saw the same instruction the planner
      // did); remove wins over retitle when it claims both.
      setDocProposals((prev) => [
        ...prev,
        {
          label: t.label,
          op:
            rd.remove === true
              ? ("remove" as const)
              : ("revise" as const),
          ...(typeof rd.heading === "string" && rd.heading && rd.remove !== true
            ? { heading: rd.heading }
            : {}),
          proposed: rd.proposed,
          current: Array.isArray(rd.current) ? rd.current : live.paragraphs,
          note: String(rd.note ?? ""),
          directive: t.directive,
        },
      ]);
    }
    setDocStopped(tronStopRef.current);
    setDocStopping(false);
    setDocRun(null);
    setDocFailures(failures);
    setTronBusy(false);
    setBusyKind(null);
  }

  /**
   * The accept write, shared by the single proposal's "Use this" and every
   * whole-document entry. Returns { error } to show, or { label } — the
   * section's label AFTER the write (a retitle of a worded label renames
   * the key itself, and every receipt and jump must follow it).
   *
   * The staleness guard: the section may have moved since Tron read it (a
   * gap answer woven in, a colleague's edit, the user's own). Accepting
   * would overwrite (or remove) that silently, because the PATCH sends
   * whole paragraphs and its rev CAS only fences writes concurrent with the
   * PATCH itself. A retitle that carries NO body change skips the guard:
   * it writes nothing the section's paragraphs hold.
   */
  async function applyProposal(p: {
    label: string;
    op?: "revise" | "retitle" | "remove";
    heading?: string;
    proposed: string[];
    current: string[];
  }): Promise<{ error: string } | { label: string }> {
    if (!proposalId) return { error: "The proposal is gone. Reload the page." };
    const op = p.op ?? "revise";
    const touchesBody = op === "remove" || op === "revise";
    const live = sectionsRef.current.find((x) => x.label === p.label);
    if (!live && (op === "retitle" || op === "remove"))
      return { error: "That section is already gone. Reload the page." };
    const changedSince =
      live !== undefined &&
      (live.paragraphs.length !== p.current.length ||
        live.paragraphs.some((q, i) => q !== p.current[i]));
    if (touchesBody && changedSince)
      return {
        error:
          "This section changed after Tron read it. Using this would undo that change. Ask Tron again so it reads the current text; if it keeps saying this, reload the page.",
      };

    // One write per accept. A revise that also carries a heading rides the
    // retitle op WITH its paragraphs, so header and body land in the same
    // CAS'd transaction instead of two half-applies.
    const body =
      op === "remove"
        ? { op: "remove", label: p.label }
        : op === "retitle" || p.heading
          ? {
              op: "retitle",
              label: p.label,
              heading: p.heading,
              ...(op === "revise" ? { paragraphs: p.proposed } : {}),
            }
          : { label: p.label, paragraphs: p.proposed };
    const res = await fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res || !res.ok) {
      const d = res ? await res.json().catch(() => null) : null;
      return {
        error:
          d?.message ??
          (res
            ? "That change was not saved."
            : "The server could not be reached."),
      };
    }
    const d = await res.json().catch(() => null);
    adoptRev(d?.rev);
    setGateResult(null);

    if (op === "remove") {
      setSections((prev) => prev.filter((s) => s.label !== p.label));
      setStructure((prev) => prev.filter((n) => n.label !== p.label));
      setRequirements((prev) =>
        prev.filter((r) => r.structureLabel !== p.label)
      );
      // A receipt chip for a section that no longer exists would render a
      // jump button that silently does nothing.
      setHighlights((prev) => {
        if (!prev.has(p.label)) return prev;
        const next = new Set(prev);
        next.delete(p.label);
        return next;
      });
      // A pure removal carries no new information: drop the label from a
      // stored dismissal signature too, so a dismissed editing-notes window
      // does not re-show announcing only the content the user already
      // dismissed. (The rename path below is different on purpose: it ends
      // in showChanged with a genuinely new label, and must re-show.)
      setReceiptDismissedSig((sig) =>
        sig === null
          ? null
          : sig
              .split("\u0000")
              .filter((l) => l !== p.label)
              .join("\u0000")
      );
      if (editing === p.label) setEditing(null);
      if (scope === p.label) setScope(DOC_LABEL);
      return { label: p.label };
    }

    // The server names the slot it filled; adopt ITS answer, never a local
    // re-derivation of the worded-label rule.
    const newLabel =
      typeof d?.label === "string" && d.label ? (d.label as string) : p.label;
    const newTitle = typeof d?.title === "string" ? (d.title as string) : null;
    setSections((prev) =>
      prev.map((s) =>
        s.label === p.label
          ? {
              ...s,
              label: newLabel,
              ...(newTitle !== null ? { title: newTitle } : {}),
              ...(op === "revise" ? { paragraphs: p.proposed } : {}),
            }
          : s
      )
    );
    if (newLabel !== p.label || newTitle !== null) {
      setStructure((prev) =>
        prev.map((n) =>
          n.label === p.label
            ? {
                ...n,
                label: newLabel,
                ...(newTitle !== null ? { title: newTitle } : {}),
              }
            : n
        )
      );
      setRequirements((prev) =>
        prev.map((r) =>
          r.structureLabel === p.label
            ? { ...r, structureLabel: newLabel }
            : r
        )
      );
      // The old label's receipt chip would jump nowhere after the rename;
      // showChanged below re-lights the section under its new key.
      setHighlights((prev) => {
        if (newLabel === p.label || !prev.has(p.label)) return prev;
        const next = new Set(prev);
        next.delete(p.label);
        return next;
      });
      if (editing === p.label) setEditing(newLabel);
      if (scope === p.label) setScope(newLabel);
    }
    showChanged([newLabel]);
    return { label: newLabel };
  }

  async function acceptProposal() {
    if (!proposal || !proposalId) return;
    const r = await applyProposal({
      label: proposal.label,
      op: proposal.remove ? "remove" : "revise",
      heading: proposal.heading ?? undefined,
      proposed: proposal.proposed,
      current: proposal.current,
    });
    if ("error" in r) {
      setTronError(r.error);
      return;
    }
    if (proposal.remove) {
      setTronApplied(null);
      setTronRemoved(tronDisplay(proposal.label));
    } else {
      setTronApplied(r.label);
      setTronRemoved(null);
    }
    setProposal(null);
    setInstruction("");
    setTronFile(null);
    setTronError("");
  }

  async function acceptDocProposal(label: string) {
    const entry = docProposals.find((p) => p.label === label);
    if (!entry) return;
    // Read BEFORE the apply: after a removal the section is gone from
    // state and the display name can no longer be derived.
    const display = tronDisplay(label);
    const r = await applyProposal(entry);
    if ("error" in r) {
      setTronError(`${display}: ${r.error}`);
      return;
    }
    if (entry.op === "remove")
      setDocRemoved((prev) => [...prev, display]);
    else setDocApplied((prev) => [...prev, r.label]);
    setDocProposals((prev) => prev.filter((p) => p.label !== label));
    // The stopped line says nothing has been written; an accept just did.
    setDocStopped(false);
    setTronError("");
  }

  /** Apply every remaining doc proposal, in order, stopping on the first
   *  failure so the section that refused is named rather than buried.
   *  docAccepting freezes the per-entry buttons for the duration: this
   *  iterates a click-time snapshot, so a Discard clicked mid-sequence
   *  would still be applied, and a second Use this would double-accept
   *  into the staleness guard's confusing error. */
  async function acceptAllDocProposals() {
    if (docAccepting) return;
    setDocAccepting(true);
    try {
      for (const entry of [...docProposals]) {
        const display = tronDisplay(entry.label);
        const r = await applyProposal(entry);
        if ("error" in r) {
          setTronError(`${display}: ${r.error}`);
          return;
        }
        if (entry.op === "remove")
          setDocRemoved((prev) => [...prev, display]);
        else setDocApplied((prev) => [...prev, r.label]);
        setDocProposals((prev) => prev.filter((p) => p.label !== entry.label));
        setDocStopped(false);
      }
      setTronError("");
    } finally {
      setDocAccepting(false);
    }
  }

  // Dismissed findings leave the VISIBLE sets (and with them the summary
  // sentence and counts); the server already recomputed `passed` over the
  // survivors at store time, so a fully-ignored run reads as passing.
  const blocks =
    gateResult?.violations.filter(
      (v) => v.severity === "block" && !v.dismissed
    ) ?? [];
  const warns =
    gateResult?.violations.filter(
      (v) => v.severity !== "block" && !v.dismissed
    ) ?? [];
  const dismissedList = gateResult?.violations.filter((v) => v.dismissed) ?? [];

  /* ---------------------------------------------------------------------- */

  const questionsReady = sections.length > 0;
  const questionsReadyRef = useRef(questionsReady);
  useEffect(() => {
    if (questionsReady && !questionsReadyRef.current) setPane("questions");
    questionsReadyRef.current = questionsReady;
  }, [questionsReady]);

  const paneButton = (k: Pane) =>
    k === "questions"
      ? queue.length > 0
        ? `Questions · ${queue.length}`
        : "Questions"
      : k === "coverage"
        ? "Coverage"
        : k === "checks"
          ? "Checks"
          : "Tron";

  return (
    <>
      {/* Workbar: the one place the document-level actions and notices
          live. Always sticky (owner directive 2026-09-30): the drafting
          status and the Run checks / Word / PDF buttons stay pinned at
          the top of the window however deep the page is scrolled. */}
      <div className="panel mb-6 rfp-runbar" ref={runbarRef}>
        {archived && (
          <p className="mb-3 text-sm">
            <span className="badge badge--warn">Archived</span>{" "}
            This RFP is out of its owner&apos;s list. It still opens, drafts,
            and exports; an admin restores it from the Archive on Your RFPs.
          </p>
        )}
        {notice && (
          <p className="mb-3 text-sm" role="status">
            {notice}{" "}
            {/* Notices are set-and-forget and now PIN the bar; without a
                dismiss, one export on a phone parks a wall of panel over
                half the viewport for the rest of the session. */}
            <button
              type="button"
              className="linklike"
              onClick={() => setNotice("")}
            >
              Dismiss
            </button>
          </p>
        )}
        {genError && !notice && <p className="mb-3 text-sm">{genError}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            {run ? (
              <p className="text-sm" role="status" aria-live="polite">
                {run.active ? (
                  <>
                    Drafting {run.done + 1} of {run.total} ·{" "}
                    <span className="mono">{run.current}</span>
                    <span className="text-faint">
                      {" "}
                      · about a minute per section
                    </span>
                  </>
                ) : (
                  <>Drafting finished.</>
                )}
              </p>
            ) : followProgress ? (
              <p className="text-sm" role="status" aria-live="polite">
                Drafting in another tab ·{" "}
                <span className="mono">{followProgress}</span>
                <span className="text-faint"> · sections land here as they finish</span>
              </p>
            ) : (
              <p className="text-sm text-faint">
                {draftedCount} of {structure.length || draftedCount}{" "}
                sections drafted
                {queue.length > 0 && (
                  <>
                    {" "}
                    · {queue.length} question{queue.length === 1 ? "" : "s"} open
                  </>
                )}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {run?.active ? (
              <button
                type="button"
                className="btn btn--text"
                onClick={() => {
                  stopRef.current = true;
                }}
              >
                Stop after this section
              </button>
            ) : undrafted.length > 0 ||
              (draftedCount > 0 && !letterSec) ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void draftAll()}
              >
                {draftedCount === 0
                  ? "Draft the whole response"
                  : undrafted.length > 0
                    ? `Draft the ${undrafted.length} remaining`
                    : "Draft the cover letter"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--text"
              disabled={
                // Frozen during an ignore/restore POST too: a gate run that
                // reads the row mid-op can store a result computed from the
                // pre-op dismissals, visibly popping the row back out of the
                // Ignored list until the next run (§5.17.8 TOCTOU).
                checking ||
                !proposalId ||
                sections.length === 0 ||
                checksBusySig !== null
              }
              onClick={() => {
                void runChecks();
                showPane("checks");
              }}
            >
              {checking ? "Checking" : "Run checks"}
            </button>
            {(queue.length > 0 || (gateResult && !gateResult.passed)) &&
              sections.length > 0 && (
                <span className="text-xs text-faint">
                  open items remain before this is final
                </span>
              )}
            <button
              type="button"
              className="btn btn--text"
              disabled={exporting !== null || sections.length === 0}
              onClick={() => void exportAs("docx")}
            >
              {exporting === "docx" ? "Building" : "Word"}
            </button>
            <button
              type="button"
              className="btn btn--text"
              disabled={exporting !== null || sections.length === 0}
              onClick={() => void exportAs("pdf")}
            >
              {exporting === "pdf" ? "Building" : "PDF"}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile switcher. Gone with the rail while the document does not
          exist yet: it has nothing to switch to. With the rail, both
          columns stay mounted below and it toggles which one shows. */}
      {!railHidden && (
      <nav className="tabstrip tabstrip--mobile mb-4" aria-label="Workspace panes">
        {(["draft", "questions", "coverage", "checks", "tron"] as const).map(
          (k) => (
            <button
              key={k}
              type="button"
              aria-pressed={k === "draft" ? mobileView === "draft" : pane === k && mobileView !== "draft"}
              disabled={k === "questions" && !questionsReady}
              title={
                k === "questions" && !questionsReady
                  ? "Available once the response is drafted"
                  : undefined
              }
              onClick={() => (k === "draft" ? setMobile("draft") : showPane(k))}
            >
              {k === "draft" ? "Draft" : paneButton(k)}
            </button>
          )
        )}
      </nav>
      )}

      {/* The two-column grid exists only with the rail. Hidden, the document
          keeps its grid column's exact width (7/12 of the row minus the
          2rem gap) and centers, so the sheets' cqw type scale does not jump
          when the rail arrives. */}
      <div
        className={
          railHidden
            ? ""
            : "lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-8"
        }
      >
        {/* ---- the rail (left at lg, like governance's question pane).
            UNMOUNTED while railHidden: every pane's state lives in this
            component, so nothing is lost, and railRef is null-guarded. ---- */}
        {!railHidden && (
        <div
          className={`${mobileView !== "draft" ? "block" : "hidden"} lg:block rfp-rail min-w-0`}
          ref={railRef}
        >
          <nav className="tabstrip tabstrip--rail" aria-label="Rail">
            {(["questions", "coverage", "checks", "tron"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={pane === k}
                disabled={k === "questions" && !questionsReady}
                title={
                  k === "questions" && !questionsReady
                    ? "Available once the response is drafted"
                    : undefined
                }
                onClick={() => showPane(k)}
              >
                {paneButton(k)}
              </button>
            ))}
          </nav>

          <div className="panel mt-4">
            {pane === "questions" && (
              <>
                {/* Provenance, not a question: never in the queue, never in
                    the open count, never blocks the done state. Renders in
                    both the current-question and done branches (a pre-export
                    review must still see where the count came from), never
                    in the draft-first empty state. THE RULE: a count is
                    applied and a draft exists. Source does not gate it (a
                    staff-entered count needs the RFP's sentences beside it
                    as much as a seeded one); it only changes the
                    attribution the row prints. The sentences sit behind a
                    disclosure so the row stays short above the questions.
                    It is also the in-pane receipt for an answered count,
                    whose wash lands in the draft column a phone hides. */}
                {inputs.fullyManagedUsers !== null && sections.length > 0 && (
                    <StatedStaffRow
                      count={inputs.fullyManagedUsers}
                      source={fmuSource}
                      statedStaff={statedStaff}
                      staff={staffCtx}
                      headcountOnly={inputs.statesHeadcountOnly}
                      busy={busy}
                      onAnswer={answerPricing}
                    />
                  )}
                {/* Above the queue AND in the done state, inside the pane a
                    phone shows. Not a question: never counted as open. */}
                {refsPrompt && (
                  <div className="mb-5">
                    <span className="sys-label">References</span>
                    <p className="mt-3 text-sm">
                      The RFP asks for{" "}
                      {referencesCountWord(refsPrompt.count)
                        ? `${referencesCountWord(refsPrompt.count)} client reference${refsPrompt.count === 1 ? "" : "s"}`
                        : "client references"}{" "}
                      and this draft lists none.
                    </p>
                    <button
                      type="button"
                      className="btn btn--primary mt-3"
                      disabled={refsBusy}
                      onClick={() => void addReferencesQuestion()}
                    >
                      {refsBusy ? "Adding" : "Add the references question"}
                    </button>
                    {refsError && (
                      <p className="mt-2 text-xs" role="alert">
                        {refsError}
                      </p>
                    )}
                  </div>
                )}
                {refsEditing && proposalId ? (
                  // Edit mode replaces the current question (or the
                  // "nothing waiting" state) until saved or cancelled; the
                  // queue is untouched underneath.
                  <>
                    <span className="sys-label">References</span>
                    <p className="mt-3">
                      Edit the references on{" "}
                      <span className="mono">{refsEditing.label}</span>
                    </p>
                    <ReferencesPicker
                      key={`edit:${refsEditing.label}`}
                      mode="edit"
                      proposalId={proposalId}
                      question={`Edit the references on ${refsEditing.label}`}
                      targets={[{ label: refsEditing.label, raw: "" }]}
                      initial={refsEditing.entries}
                      asked={null}
                      disabled={busy || visualBusy !== null}
                      onAnswered={(r) => {
                        const label = refsEditing.label;
                        setSections(r.sections as typeof sections);
                        adoptRev(r.rev);
                        setGateResult(null);
                        showChanged([label]);
                        const n = r.kept + r.created;
                        setNotice(
                          r.note ??
                            (n > 0
                              ? `Contacts saved to the shared reference file for ${n} reference${n === 1 ? "" : "s"}.`
                              : "")
                        );
                        setRefsEdit(null);
                      }}
                      onCancel={() => setRefsEdit(null)}
                    />
                  </>
                ) : sections.length === 0 ? (
                  <>
                    <span className="sys-label">Questions</span>
                    <p className="mt-3 text-sm text-faint">
                      Draft the response first. The questions the knowledge
                      base cannot answer, and the pricing quantities, collect
                      here.
                    </p>
                  </>
                ) : current ? (
                  <>
                    {lastWoven && (
                      <p className="mb-3 text-xs text-faint" role="status">
                        Woven into <span className="mono">{lastWoven}</span>.{" "}
                        <button
                          type="button"
                          className="linklike"
                          onClick={() => {
                            setMobile("draft");
                            window.setTimeout(
                              () => jumpTo(lastWoven.split(", ")[0]),
                              60
                            );
                          }}
                        >
                          View the section
                        </button>
                      </p>
                    )}
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="sys-label">Question</span>
                      <span className="text-xs text-faint">
                        {open.length} open
                        {answeredCount > 0
                          ? ` · ${answeredCount} answered`
                          : ""}
                      </span>
                    </div>
                    {current.kind === "gap" && (
                      <p className="mt-3 text-xs text-faint mono">
                        {current.targets
                          .map((t) => `${t.label} ${t.sectionTitle}`.trim())
                          .join(" · ")}
                      </p>
                    )}
                    {current.kind === "pricing" &&
                      current.field === "fullyManagedUsers" && (
                        // The user count LEADS with what is already known
                        // (owner, 2026-09-30): the monthly minimum, then
                        // every sentence the RFP spends on staff, so the
                        // answer is a decision on shown evidence and never
                        // a bare ask. Shown at every size.
                        <>
                          {staffCtx.floor && (
                            <MinimumNote floor={staffCtx.floor} />
                          )}
                          <StaffEvidence quotes={staffCtx.evidence} />
                        </>
                      )}
                    <p className="mt-3">{current.text}</p>
                    {current.why && (
                      // pre-line: the references why arrives as separate
                      // lines (the ask, the holdings, the shortlist).
                      <p className="mt-2 whitespace-pre-line text-xs text-faint">
                        {current.why}
                      </p>
                    )}

                    {run?.active && (
                      <p className="mt-3 text-xs text-faint" role="status">
                        Drafting is running; answers apply once the current
                        section lands.
                      </p>
                    )}
                    {weaving === current.key ? (
                      <p className="mt-4 text-sm" role="status" aria-live="polite">
                        Weaving your answer into{" "}
                        <span className="mono">{weaveProgress}</span>. Each
                        section updates as it lands · about a minute apiece.
                      </p>
                    ) : current.kind === "pricing" ? (
                      <>
                        <PricingAnswer
                          key={current.key}
                          q={current}
                          busy={busy}
                          headcountOnlySet={inputs.statesHeadcountOnly}
                          onAnswer={answerPricing}
                        />
                        <button
                          type="button"
                          className="btn btn--text mt-3"
                          onClick={() =>
                            setSkipped((sk) => new Set(sk).add(current.key))
                          }
                        >
                          Skip for now
                        </button>
                      </>
                    ) : currentIsReferences && !refsWords && proposalId ? (
                      // The references question as a form (§5.17.9): the
                      // response is the whole sections array, adopted like
                      // addReferencesQuestion's. Skip stays here, with the
                      // queue it belongs to.
                      <>
                        <ReferencesPicker
                          key={current.key}
                          proposalId={proposalId}
                          question={current.text}
                          targets={current.targets}
                          asked={refsAsked}
                          disabled={busy}
                          onAnswered={(r) => {
                            // Only the first target gains the cards; the
                            // question merely closes on the others.
                            const gained = r.labels.slice(0, 1);
                            setSections(r.sections as typeof sections);
                            adoptRev(r.rev);
                            setGateResult(null);
                            showChanged(gained);
                            setAnsweredCount((n) => n + 1);
                            setAnswerText("");
                            setLastWoven(gained[0] ?? null);
                            const n = r.kept + r.created;
                            setNotice(
                              r.note ??
                                (n > 0
                                  ? `Contacts saved to the shared reference file for ${n} reference${n === 1 ? "" : "s"}.`
                                  : "")
                            );
                          }}
                          onWords={() => setRefsWordsKey(current.key)}
                        />
                        <button
                          type="button"
                          className="btn btn--text mt-3"
                          onClick={() => {
                            setSkipped((s) => new Set(s).add(current.key));
                            setAnswerText("");
                            setAnswerInvalid(false);
                          }}
                        >
                          Skip for now
                        </button>
                      </>
                    ) : (
                      <form
                        className="mt-4"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (answerText.trim().length < 2) {
                            setAnswerInvalid(true);
                            return;
                          }
                          void answerGap(
                            current as Extract<OpenQuestion, { kind: "gap" }>
                          );
                        }}
                      >
                        <textarea
                          className="input min-h-28 w-full"
                          value={answerText}
                          onChange={(e) => {
                            setAnswerText(e.target.value);
                            setAnswerInvalid(false);
                          }}
                          aria-label={current.text}
                          aria-invalid={answerInvalid ? true : undefined}
                          placeholder={
                            currentIsReferences
                              ? "List each reference: organization, contact name, title, phone, email."
                              : "Answer in plain language. It gets woven into the section, not pasted."
                          }
                        />
                        {answerInvalid && (
                          <p className="mt-2 text-xs" role="alert">
                            Type your answer first. A few words is enough.
                          </p>
                        )}
                        {currentIsReferences ? (
                          <p className="mt-3 text-xs text-faint">
                            Answered in words, the contacts are woven into the
                            text and not kept on file.
                          </p>
                        ) : (
                          <label className="mt-3 flex items-start gap-2 text-xs text-faint">
                            <input
                              type="checkbox"
                              checked={remember}
                              onChange={(e) => setRemember(e.target.checked)}
                            />
                            <span>
                              Keep this answer for my future RFPs (only my
                              drafts see it; share it with everyone from
                              Knowledge, where an admin approves it)
                            </span>
                          </label>
                        )}
                        <div className="mt-4 flex flex-wrap gap-3">
                          <button
                            type="submit"
                            className="btn btn--primary"
                            disabled={busy}
                          >
                            Answer
                          </button>
                          <button
                            type="button"
                            className="btn btn--text"
                            onClick={() => {
                              setSkipped((s) => new Set(s).add(current.key));
                              setAnswerText("");
                              setAnswerInvalid(false);
                            }}
                          >
                            Skip for now
                          </button>
                        </div>
                      </form>
                    )}
                  </>
                ) : (
                  <>
                    <span className="sys-label">Questions</span>
                    <p className="mt-3 text-sm">
                      {queue.length === 0
                        ? refsPrompt
                          ? // The references prompt above is waiting: never
                            // claim nothing is.
                            "No questions are open. The references request above still needs a decision."
                          : "Nothing is waiting on you. Run the checks, then export."
                        : `Every remaining question is skipped (${queue.length}). They stay listed on their sections until answered.`}
                    </p>
                    {skipped.size > 0 && (
                      <button
                        type="button"
                        className="btn btn--text mt-3"
                        onClick={() => setSkipped(new Set())}
                      >
                        Revisit skipped questions
                      </button>
                    )}
                    {queue.length === 0 && sections.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-3">
                        <button
                          type="button"
                          className="btn btn--primary"
                          disabled={checking || checksBusySig !== null}
                          onClick={() => {
                            void runChecks();
                            showPane("checks");
                          }}
                        >
                          Run the checks
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {pane === "coverage" && (
              <>
                <span className="sys-label">
                  {draftedCount} of {structure.length} sections drafted
                </span>
                <p className="mt-3 text-sm text-faint">
                  Every ask the client made, in their words and their order.
                </p>
                {/* No inner scrollbox: the rail itself scrolls at lg, and
                    stacking a second scrollbar inside it was part of the
                    maneuvering problem (owner, 2026-08-28). */}
                <div className="mt-4">
                  {requirements.map((r) => (
                    <div className="rfp-row" key={r.id}>
                      <div className="mono text-xs text-faint">
                        {r.structureLabel}
                      </div>
                      <p className="text-sm">{r.text}</p>
                      <span
                        className={`badge${covered.has(r.structureLabel) ? " badge--ok" : " badge--warn"}`}
                      >
                        {covered.has(r.structureLabel) ? "Drafted" : "Not yet"}
                      </span>
                      {/* A route INTO the paper: without this, coverage was
                          dead text and the sheet was a scroll hunt away. */}
                      <button
                        type="button"
                        className="linklike text-xs"
                        onClick={() => {
                          setMobile("draft");
                          window.setTimeout(() => jumpTo(r.structureLabel), 60);
                        }}
                      >
                        View the section
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {pane === "checks" && (
              <>
                <span className="sys-label">Checks</span>
                {!gateResult ? (
                  <p className="mt-3 text-sm">
                    {gapQuestionCount === 0
                      ? "The compliance rules have not run on this draft yet. Run them from the bar above."
                      : `${gapQuestionCount} open question${gapQuestionCount === 1 ? "" : "s"} across ${gapSectionCount} section${gapSectionCount === 1 ? "" : "s"}. The Questions pane walks through them.`}
                  </p>
                ) : (
                  <>
                    <p className="mt-3 text-sm">
                      {/* A pass earned by dismissals says so: "Passing" with
                          every blocking finding sitting in the Ignored list
                          would read as a clean run. */}
                      {gateResult.passed
                        ? queue.length > 0
                          ? `The rules pass${dismissedList.length ? ` with ${dismissedList.length} ignored finding${dismissedList.length === 1 ? "" : "s"}` : ""}. ${queue.length} open question${queue.length === 1 ? "" : "s"} remain${queue.length === 1 ? "s" : ""}; the Questions pane walks through them.`
                          : `Passing${dismissedList.length ? ` with ${dismissedList.length} ignored finding${dismissedList.length === 1 ? "" : "s"}` : ""}. Nothing blocks export.`
                        : `${blocks.length} blocking finding${blocks.length === 1 ? "" : "s"}${warns.length ? ` and ${warns.length} advisory` : ""}. Fix them before this response is sent.`}
                    </p>
                    <div className="mt-4 space-y-3">
                      {[...blocks, ...warns].map((v, i) => {
                        const sig = findingSig(v);
                        // One request at a time, and never while the gate,
                        // Tron, or a draft run could replace the result
                        // under the click.
                        const rowsFrozen =
                          checking ||
                          tronBusy ||
                          (run?.active ?? false) ||
                          checksBusySig !== null;
                        return (
                        <div key={`${sig}\u0000${i}`} className="text-sm">
                          <span
                            className={`badge${v.severity === "block" ? " badge--warn" : ""}`}
                          >
                            {v.ruleId}
                          </span>{" "}
                          {/* §5.17. A rule that names a stored instant sends the
                              sentence SPLIT (Violation.timedMessage) instead of a
                              formatted day, because a message string is built on the
                              server and would carry the VM's UTC day. Today only C1
                              does. <LocalTime> and not exact(): this pane's gateResult
                              can arrive as a SERVER PROP seeded from the stored
                              gate_json, so these spans are server-rendered on first
                              paint, and a runtime-zone formatter would resolve to UTC
                              on the server and the reader's zone in the browser (a text
                              hydration mismatch). <LocalTime>'s UTC-pinned seed emits
                              the same bytes on both sides and swaps zones after mount.
                              The `message` fallback is not dead code: it is what a
                              gate_json row stored before 2026-08-26 renders, and what
                              every rule but C1 renders. */}
                          {v.timedMessage ? (
                            <>
                              {v.timedMessage.segments.map((seg, si) => (
                                <Fragment key={si}>
                                  {seg.before}
                                  <LocalTime iso={seg.iso} withTime />
                                </Fragment>
                              ))}
                              {v.timedMessage.after}
                            </>
                          ) : (
                            v.message
                          )}
                          {/* Ignore persists a dismissal (the row moves to
                              the Ignored list below, which IS its receipt);
                              Fix it hands the finding to the machinery that
                              resolves it, most often a scoped Tron run whose
                              progress shows in the same rail. */}
                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              className="btn btn--text"
                              disabled={rowsFrozen}
                              aria-busy={checksBusySig === sig || undefined}
                              onClick={() => void postChecksOp("ignore", sig)}
                            >
                              {checksBusySig === sig ? "Ignoring" : "Ignore"}
                            </button>
                            <button
                              type="button"
                              className="btn btn--text"
                              disabled={rowsFrozen}
                              onClick={() => fixIt(v, sig)}
                            >
                              Fix it
                            </button>
                          </div>
                          {checksError?.sig === sig && (
                            <p className="mt-2 text-sm" role="alert">
                              {checksError.message}
                            </p>
                          )}
                          {fixAsk?.sig === sig && (
                            <div className="mt-2">
                              <p className="text-xs text-faint">
                                {fixAsk.prompt}
                              </p>
                              <textarea
                                className="input mt-1 w-full"
                                value={fixAsk.text}
                                onChange={(e) =>
                                  setFixAsk((cur) =>
                                    cur ? { ...cur, text: e.target.value } : cur
                                  )
                                }
                                aria-label="Optional context for the fix"
                              />
                              <div className="mt-2 flex flex-wrap gap-3">
                                <button
                                  type="button"
                                  className="btn btn--primary"
                                  disabled={rowsFrozen}
                                  onClick={() => {
                                    const ask = fixAsk;
                                    if (!ask) return;
                                    setFixAsk(null);
                                    runFix(
                                      ask.label,
                                      fixInstruction(v, ask.text)
                                    );
                                  }}
                                >
                                  Fix it
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--text"
                                  onClick={() => setFixAsk(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                          {fixNote?.sig === sig && (
                            <p className="mt-2 text-sm" role="status">
                              {fixNote.message}
                              {fixNote.pricing && questionsReady && (
                                <>
                                  {" "}
                                  <button
                                    type="button"
                                    className="linklike"
                                    onClick={() => showPane("questions")}
                                  >
                                    Open the Questions pane
                                  </button>
                                </>
                              )}
                            </p>
                          )}
                        </div>
                        );
                      })}
                      {gateResult.errors.map((e, i) => (
                        <div key={`e${i}`} className="text-sm">
                          <span className="badge badge--warn">
                            {e.ruleId} errored
                          </span>{" "}
                          {e.message}
                        </div>
                      ))}
                    </div>
                    {dismissedList.length > 0 && (
                      <div className="mt-5">
                        <button
                          type="button"
                          className="btn btn--text"
                          aria-expanded={ignoredOpen}
                          onClick={() => setIgnoredOpen((o) => !o)}
                        >
                          Ignored ({dismissedList.length})
                        </button>
                        {ignoredOpen && (
                          <div className="mt-3 space-y-3">
                            {dismissedList.map((v, i) => {
                              const sig = findingSig(v);
                              const d = v.dismissed!;
                              return (
                                <div key={`${sig}\u0000${i}`} className="text-sm">
                                  <span className="badge">{v.ruleId}</span>{" "}
                                  {v.message}
                                  <p className="mt-1 text-xs text-faint">
                                    {/* <LocalTime>, never a runtime
                                        formatter: this pane SSRs from the
                                        stored gate_json (the trap the
                                        timedMessage comment above records),
                                        and dismissed.at arrives through the
                                        same prop. */}
                                    Ignored by {d.by.split("@")[0]} ·{" "}
                                    <LocalTime iso={d.at} withTime />
                                  </p>
                                  <button
                                    type="button"
                                    className="btn btn--text mt-1"
                                    disabled={
                                      checking ||
                                      tronBusy ||
                                      (run?.active ?? false) ||
                                      checksBusySig !== null
                                    }
                                    aria-busy={
                                      checksBusySig === sig || undefined
                                    }
                                    onClick={() =>
                                      void postChecksOp("restore", sig)
                                    }
                                  >
                                    {checksBusySig === sig
                                      ? "Restoring"
                                      : "Restore"}
                                  </button>
                                  {checksError?.sig === sig && (
                                    <p className="mt-1 text-sm" role="alert">
                                      {checksError.message}
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                {gapQuestionCount > 0 && gateResult && (
                  <p className="mt-4 text-sm text-faint">
                    Plus {gapQuestionCount} open question
                    {gapQuestionCount === 1 ? "" : "s"} on the sections,
                    answered in the Questions pane.
                  </p>
                )}
              </>
            )}

            {pane === "tron" && (
              <>
                <span className="sys-label">Ask Tron for a change</span>
                {sections.length === 0 ? (
                  <p className="mt-3 text-sm text-faint">
                    Nothing to revise yet. Tron reworks text that has already
                    been drafted; draft a section first.
                  </p>
                ) : (
                  <>
                {run?.active && (
                  <p className="mt-3 text-xs text-faint">
                    Drafting is running. Tron still works on the sections
                    already drafted.
                  </p>
                )}
                <label className="mt-4 block text-sm">
                  <span className="text-faint">Section</span>
                  <select
                    className="input mt-1 w-full"
                    value={scope ?? DOC_LABEL}
                    onChange={(e) => pickScope(e.target.value)}
                  >
                    <option value={DOC_LABEL}>The whole document</option>
                    {tronScopeOptions(sections).map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.text}
                      </option>
                    ))}
                  </select>
                </label>
                <textarea
                  className="input mt-4 min-h-32 w-full"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Tighten this to three sentences and lead with the response time."
                  aria-label="What should change"
                />
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <label className="btn btn--text cursor-pointer">
                    {tronFile ? "Swap document" : "Attach a document"}
                    <input
                      type="file"
                      className="sr-only"
                      accept=".pdf,.docx,.txt,.md,.csv,.log,.json"
                      onChange={(e) =>
                        setTronFile(e.target.files?.[0] ?? null)
                      }
                    />
                  </label>
                  {tronFile && (
                    <span className="mono text-xs">
                      {tronFile.name}{" "}
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => setTronFile(null)}
                      >
                        remove
                      </button>
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs text-faint">
                  Tron can reword, tighten, reorder, rename section headers,
                  remove whole sections, and work from an attached PDF,
                  Word, or text file as you direct. The whole document is
                  the default scope: Tron plans the change first, then
                  proposes a revision for each affected section. It will not
                  add a price, a contract length, or a claim the knowledge
                  base does not support. Images cannot be read yet.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={tronBusy || !scope || instruction.trim().length < 3}
                    // Wrapped: passing the click event where the overrides
                    // parameter goes would read event.label as the scope.
                    onClick={() => void askTron()}
                  >
                    {tronBusy ? "Thinking" : "Propose a change"}
                  </button>
                  {docRun && (
                    <button
                      type="button"
                      className="btn btn--text"
                      disabled={docStopping}
                      onClick={() => {
                        tronStopRef.current = true;
                        setDocStopping(true);
                      }}
                    >
                      {docStopping
                        ? "Stopping after this section"
                        : "Stop after this section"}
                    </button>
                  )}
                </div>
                {busyKind === "section" && (
                  <p className="mt-3 text-sm text-faint" role="status">
                    Reading the section{tronFile ? " and your document" : ""}.
                    Under a minute.
                  </p>
                )}
                {busyKind === "doc" && !docRun && (
                  <p className="mt-3 text-sm text-faint" role="status">
                    Planning the changes across the whole document. Under two
                    minutes.
                  </p>
                )}
                {docRun && (
                  <p className="mt-3 text-sm text-faint" role="status">
                    Revising <span className="mono">{docRun.current}</span> (
                    {docRun.done + 1} of {docRun.total}). Under a minute each.
                    Nothing is written until you use a proposal.
                  </p>
                )}
                {tronError && (
                  <p className="mt-3 text-sm" role="alert">
                    {tronError}
                  </p>
                )}
                {tronApplied && !proposal && (
                  <p className="mt-3 text-xs text-faint" role="status">
                    Used in{" "}
                    <span className="mono">
                      {tronApplied === LETTER_LABEL ? LETTER_TITLE : tronApplied}
                    </span>
                    .{" "}
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => {
                        setMobile("draft");
                        window.setTimeout(() => jumpTo(tronApplied), 60);
                      }}
                    >
                      View the section
                    </button>
                  </p>
                )}
                {tronRemoved && !proposal && (
                  <p className="mt-3 text-xs text-faint" role="status">
                    Removed <span className="mono">{tronRemoved}</span> from
                    the document.
                  </p>
                )}
                {docStopped && (
                  <p className="mt-3 text-sm text-faint" role="status">
                    Stopped.{" "}
                    {/* Phrased off docApplied AND docRemoved at RENDER
                        time: an accept or a removal can land mid-run,
                        before this line exists, and "nothing has been
                        written" would then be false — for a removal,
                        dangerously so. */}
                    {docApplied.length + docRemoved.length > 0
                      ? "The changes you already used are saved; nothing else has been written."
                      : docProposals.length > 0
                        ? "The proposals already collected are below; nothing has been written."
                        : "Nothing has been written."}
                  </p>
                )}
                {docPlanNote && (
                  <p className="mt-3 text-sm text-faint" role="status">
                    {docPlanNote}
                  </p>
                )}
                {docFailures.length > 0 && (
                  <div className="mt-3 space-y-1 text-sm" role="alert">
                    {docFailures.map((f, i) => (
                      <p key={i}>{f}</p>
                    ))}
                  </div>
                )}
                {docApplied.length > 0 &&
                  docProposals.length === 0 &&
                  !docRun &&
                  !tronBusy && (
                    <p className="mt-3 text-xs text-faint" role="status">
                      Used in {docApplied.length} section
                      {docApplied.length === 1 ? "" : "s"}.{" "}
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => {
                          setMobile("draft");
                          window.setTimeout(() => jumpTo(docApplied[0]), 60);
                        }}
                      >
                        View the first
                      </button>
                    </p>
                  )}
                {/* Removals get their own worded receipt: the entry
                    vanishing from the list is NOT confirmation, and on
                    mobile the draft column is hidden anyway. */}
                {docRemoved.length > 0 && (
                  <p className="mt-3 text-xs text-faint" role="status">
                    Removed from the document:{" "}
                    <span className="mono">{docRemoved.join(" · ")}</span>.
                  </p>
                )}

                {proposal && (
                  <div className="mt-6 border-t pt-4" style={{ borderColor: "var(--xl-line)" }}>
                    <span className="sys-label">
                      Proposed for{" "}
                      {proposal.label === LETTER_LABEL
                        ? LETTER_TITLE
                        : proposal.label}
                    </span>
                    {proposal.note && (
                      <p className="mt-3 text-sm text-faint">{proposal.note}</p>
                    )}
                    {proposal.remove ? (
                      <p className="mt-3 text-sm">
                        Removes this section, header included. The client
                        asks recorded under it leave Coverage and the checks
                        with it, for this and every later draft of this RFP.
                      </p>
                    ) : (
                      <>
                        {proposal.heading && (
                          <p className="mt-3 text-sm">
                            Header becomes{" "}
                            <span className="mono">{proposal.heading}</span>.
                          </p>
                        )}
                        <div className="mt-3 space-y-3 text-sm">
                          {proposal.proposed.map((p, i) => (
                            <p key={i}>{p}</p>
                          ))}
                        </div>
                        <VisualsKeptNote
                          count={blocksByLabel.get(proposal.label)?.length ?? 0}
                        />
                      </>
                    )}
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={tronBusy}
                        onClick={acceptProposal}
                      >
                        {proposal.remove ? "Remove the section" : "Use this"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--text"
                        onClick={() => setProposal(null)}
                      >
                        Discard
                      </button>
                    </div>
                    <details className="mt-3">
                      <summary className="linklike text-xs">
                        {proposal.remove
                          ? "The text it removes"
                          : "The text it replaces"}
                      </summary>
                      <div className="mt-2 space-y-2 text-xs text-faint">
                        {proposal.current.map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                      </div>
                    </details>
                  </div>
                )}

                {docProposals.length > 0 && (
                  <div
                    className="mt-6 border-t pt-4"
                    style={{ borderColor: "var(--xl-line)" }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      {/* Removals are called out in the aggregate line AND
                          on the bulk button: "Use all" must never quietly
                          delete sections the reader did not scroll to. */}
                      <span className="sys-label">
                        Proposed for {docProposals.length} section
                        {docProposals.length === 1 ? "" : "s"}
                        {docProposals.some((p) => p.op === "remove")
                          ? ` (${docProposals.filter((p) => p.op === "remove").length} of them removals)`
                          : ""}
                        {docRun ? ", more on the way" : ""}
                      </span>
                      {docProposals.length > 1 && (
                        // Disabled while the loop still collects: applying a
                        // snapshot mid-run would strand the entries that
                        // land after the click.
                        <button
                          type="button"
                          className="btn btn--text"
                          disabled={tronBusy || docAccepting}
                          onClick={() => void acceptAllDocProposals()}
                        >
                          {docAccepting
                            ? "Using all"
                            : docProposals.some((p) => p.op === "remove")
                              ? "Use all, removals included"
                              : "Use all"}
                        </button>
                      )}
                    </div>
                    {docProposals.map((p) => (
                      <div
                        key={p.label}
                        className="mt-4 border-t pt-4"
                        style={{ borderColor: "var(--xl-line)" }}
                      >
                        <span className="sys-label">
                          {tronDisplay(p.label)}
                        </span>
                        {p.directive && (
                          <p className="mt-1 text-xs text-faint">
                            {p.directive}
                          </p>
                        )}
                        {p.note && (
                          <p className="mt-3 text-sm text-faint">{p.note}</p>
                        )}
                        {p.op === "remove" ? (
                          <p className="mt-3 text-sm">
                            Removes this section, header included. The client
                            asks recorded under it leave Coverage and the
                            checks with it, for this and every later draft
                            of this RFP.
                          </p>
                        ) : p.op === "retitle" ? (
                          // A retitle touches ONLY the header: no body
                          // preview, no "text it replaces" (that reads as
                          // a body wipe when the proposed list is empty).
                          <p className="mt-3 text-sm">
                            Renames the header{" "}
                            <span className="mono">{tronDisplay(p.label)}</span>{" "}
                            to <span className="mono">{p.heading}</span>. The
                            text under it is not touched.
                          </p>
                        ) : (
                          <>
                            {p.heading && (
                              <p className="mt-3 text-sm">
                                Header becomes{" "}
                                <span className="mono">{p.heading}</span>.
                              </p>
                            )}
                            <div className="mt-3 space-y-3 text-sm">
                              {p.proposed.map((q, i) => (
                                <p key={i}>{q}</p>
                              ))}
                            </div>
                            <VisualsKeptNote
                              count={blocksByLabel.get(p.label)?.length ?? 0}
                            />
                          </>
                        )}
                        <div className="mt-4 flex flex-wrap gap-3">
                          <button
                            type="button"
                            className="btn btn--primary"
                            disabled={docAccepting}
                            onClick={() => void acceptDocProposal(p.label)}
                          >
                            {p.op === "remove"
                              ? "Remove the section"
                              : p.op === "retitle"
                                ? "Rename the header"
                                : "Use this"}
                          </button>
                          <button
                            type="button"
                            className="btn btn--text"
                            disabled={docAccepting}
                            onClick={() =>
                              setDocProposals((prev) =>
                                prev.filter((x) => x.label !== p.label)
                              )
                            }
                          >
                            Discard
                          </button>
                        </div>
                        {p.op !== "retitle" && (
                          <details className="mt-3">
                            <summary className="linklike text-xs">
                              {p.op === "remove"
                                ? "The text it removes"
                                : "The text it replaces"}
                            </summary>
                            <div className="mt-2 space-y-2 text-xs text-faint">
                              {p.current.map((q, i) => (
                                <p key={i}>{q}</p>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
        )}
        {/* ---- the document (right at lg, like governance's doc pane).
            The RAIL precedes it in the DOM (see below-moved markup): at lg
            the visual order is rail-left/doc-right AND the keyboard order
            matches — an order-utility swap once ran focus through dozens of
            per-section buttons before the guided flow. ---- */}
        <section
          ref={docPaneRef}
          tabIndex={-1}
          className={`${mobileView === "draft" ? "block" : "hidden"} lg:block min-w-0 rfp-docpane${railHidden ? " lg:w-[calc((100%_-_2rem)*7/12)] lg:mx-auto" : ""}`}
          aria-label="The document. Updates as you answer."
        >
          {/* Permanently mounted status region: the sticky receipt renders
              inside it, so a change is ANNOUNCED (the pane's aria-label
              promises "updates as you answer") and expiry empties the
              region without unmounting it. */}
          <div className="rfp-doc-receipt" role="status">
            {/* The receipt renders inside the editing-notes window (owner
                directive 2026-09-21, chrome shared with the governance doc
                pane via doc-notes.css): obviously UI, never proposal text.
                The X hides the window under its content signature; the
                highlights set is untouched, so the section chips live on. */}
            {highlights.size > 0 && receiptSig !== receiptDismissedSig && (
              <div className="doc-notes">
                <div className="doc-notes-head">
                  <span className="doc-notes-label">Editing notes</span>
                  <button
                    type="button"
                    className="doc-notes-x"
                    aria-label="Close editing notes"
                    onClick={() => {
                      setReceiptDismissedSig(receiptSig);
                      docPaneRef.current?.focus();
                    }}
                  >
                    {"×"}
                  </button>
                </div>
                <p className="doc-notes-line text-sm">
                  <span className="sys-label">Updated just now</span>
                  {[...highlights].map((h) => (
                    <button
                      key={h}
                      type="button"
                      className="linklike"
                      onClick={() => jumpTo(h)}
                    >
                      {h === "__pricing"
                        ? "Investment"
                        : h === LETTER_LABEL
                          ? LETTER_TITLE
                          : secKicker(h)}
                    </button>
                  ))}
                </p>
              </div>
            )}
          </div>
          {/* The one legend for the tool chrome below (owner directive
              2026-09-30: the draft you see must be exactly the draft you
              download, so every workspace-only control on a sheet wears
              the dashed .rfpdoc-tool panel and this line says what it
              means, once). */}
          {structure.length > 0 && (
            <p className="mb-3 text-xs text-faint rfp-doc-legend">
              The white pages are the download. Anything dashed gray, a
              panel or a whole page, is workspace only and is not in the
              download.
            </p>
          )}
          {structure.length === 0 ? (
            docStatus !== "extracted" ? (
              <ReadAgain documentId={documentId} initialStatus={docStatus} />
            ) : (
              <div className="panel">
                <p className="text-faint">
                  No section structure was found in this RFP. That usually
                  means it is a form to fill in rather than a document to
                  write, which this workspace cannot draft yet. The
                  requirements it did find are listed under Coverage.
                </p>
              </div>
            )
          ) : (
            <div className="rfpdoc">
              {/* Page 1 — the cover, in the handoff's arc-mark style:
                  corner circles, logo, kicker over the title, accent bar,
                  serif lede, and the submitted-by grid on the bottom edge. */}
              <header
                className="rfpdoc-page rfpdoc-page--sheet"
                aria-label="Cover page"
              >
                <div className="rfpdoc-cover">
                  <img
                    className="rfpdoc-logo"
                    src="/brand/xlnet-logo.png"
                    alt="XL.net"
                  />
                  <div>
                    <div className="rfpdoc-kicker rfpdoc-kicker--cover">
                      Managed IT Services Proposal
                    </div>
                    {/* The export's cover title and client, not the stored
                        document title: that is often an upload's filename,
                        and the file never printed it. */}
                    <h3 className="rfpdoc-title mt-5">{COVER_TITLE}</h3>
                    <div className="rfpdoc-bar mt-7" />
                    <p className="rfpdoc-lede mt-6">
                      Prepared
                      {coverClientName ? (
                        <>
                          {" "}for <strong>{coverClientName}</strong>
                        </>
                      ) : null}{" "}
                      in response to the Request for Proposal.
                    </p>
                  </div>
                  <div className="rfpdoc-meta">
                    <div>
                      <div className="rfpdoc-metalabel">Submitted by</div>
                      XL.net Inc.
                      <br />
                      {preparedBy}
                    </div>
                    <div>
                      <div className="rfpdoc-metalabel">Contact</div>
                      {ownerEmail}
                      {/* The reference cover carries the phone under the
                          email; directory furniture, not a claim. */}
                      {signature.phone && (
                        <>
                          <br />
                          {signature.phone}
                        </>
                      )}
                    </div>
                    <div>
                      <div className="rfpdoc-metalabel">Date</div>
                      <span suppressHydrationWarning>{dateLabel}</span>
                    </div>
                  </div>
                </div>
                <PageFoot />
              </header>

              {/* Page 2 — the cover letter. Its body DRAFTS, under the
                  reserved "__letter" record, and drafts LAST: a high-level
                  summary of the finished sections (owner directive
                  2026-08-02; drafted first it was two sentences). Date,
                  addressee, salutation, and the standard XL.net signature
                  block stay host furniture. */}
              <section
                className="rfpdoc-page"
                aria-label="Cover letter"
                id={`sec-${LETTER_LABEL}`}
              >
                <div
                  className={
                    highlights.has(LETTER_LABEL)
                      ? "doc-sec--changed doc-sec--flash"
                      : undefined
                  }
                  key={`c-${flashSeq.current.get(LETTER_LABEL) ?? 0}`}
                >
                  <div className="rfpdoc-pagehead">
                    <img
                      className="rfpdoc-logo rfpdoc-logo--sm"
                      src="/brand/xlnet-logo.png"
                      alt="XL.net"
                    />
                    <span className="rfpdoc-kicker">
                      Cover Letter
                      {highlights.has(LETTER_LABEL) && (
                        <span className="doc-chip">Updated</span>
                      )}
                    </span>
                  </div>
                  {/* ONE tool panel for the letter's controls and its
                      status lines: everything in it is workspace, none of
                      it is in the download (the export prints the letter
                      body only). */}
                  <div className="rfpdoc-tool mt-2">
                  <span className="rfpdoc-tool-label">
                    Workspace · not in the download
                  </span>
                  <div className="rfpdoc-actions flex flex-wrap items-center gap-4">
                    {letterSec ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(LETTER_LABEL);
                            setEditText(letterSec.paragraphs.join("\n\n"));
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => pickScope(LETTER_LABEL)}
                        >
                          Ask Tron
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            generate(LETTER_LABEL, LETTER_TITLE, true)
                          }
                        >
                          {run?.active && run.currentLabel === LETTER_LABEL
                            ? "Drafting"
                            : letterSec.generatedBy === "human"
                              ? "Redraft (replaces your edit)"
                              : "Redraft from the sections"}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || draftedCount === 0}
                        onClick={() => generate(LETTER_LABEL, LETTER_TITLE)}
                      >
                        {run?.active && run.currentLabel === LETTER_LABEL
                          ? "Drafting"
                          : "Draft the cover letter"}
                      </button>
                    )}
                    {/* Owner directive 2026-08-26. <When>, never a bare
                        when(), because this whole workspace is SSR'd: the
                        file is "use client", but page.tsx is an async server
                        component that statically imports and renders
                        <Workspace> (no next/dynamic and no ssr:false
                        anywhere under src/app/rfp), so the App Router
                        renders it on the VM first and hydrates it in the
                        browser second. when() disagrees across those two
                        runs on BOTH branches: past 7 days it falls through
                        to an Intl.DateTimeFormat with no pinned zone, which
                        is UTC on the VM and the reader's zone in the
                        browser; under 7 days it measures against
                        Date.now(), which has moved by the time hydration
                        runs and flips "59 minutes ago" to "1 hour ago" on
                        its own. Either way the two renders emit different
                        text, and there is no Suspense boundary between here
                        and the router root, so React discards the server
                        HTML for the WHOLE page and client-renders it again
                        - the timestamp lands correct only by accident, paid
                        for with a full-root re-render. <When> seeds its
                        state with the same string the server computed so
                        the first client render matches byte for byte, re-runs
                        when() in a deferred effect to land the viewer's zone,
                        and carries suppressHydrationWarning for the case
                        where the two clocks straddle a minute. updatedAt is
                        already an ISO string on every path (all three
                        writers stamp new Date().toISOString() and it
                        survives as JSON in sectionsJson), so no conversion
                        here. */}
                    {/* LAST in this flex row, deliberately. On the
                        post-mount zone swap this string roughly doubles (12
                        characters to about 26, at 10px uppercase with 0.18em
                        tracking), and flex-wrap only ever displaces what
                        comes AFTER the item that grew. Sitting first, as it
                        did, it pushed Edit / Ask Tron / Redraft onto a
                        second line the moment hydration landed; last, it
                        wraps alone and the buttons keep fixed offsets. Same
                        rule the repo already applies on /work/submit: the
                        item that grows goes at the end of the row. */}
                    {letterSec && (
                      <span className="rfpdoc-faint">
                        <When iso={letterSec.updatedAt} />
                      </span>
                    )}
                  </div>
                  {run?.active && run.currentLabel === LETTER_LABEL && (
                    <p className="rfpdoc-faint mt-3 text-sm" role="status">
                      Reading the drafted sections and summarizing them.
                      This takes about a minute.
                    </p>
                  )}
                  {!letterSec && !run?.active && (
                    <p className="rfpdoc-faint mt-3 text-xs italic">
                      The letter drafts last, as a summary of the whole
                      response, once the sections below are written.
                    </p>
                  )}
                  {letterStale && !run?.active && (
                    <p className="rfpdoc-faint mt-3 text-xs" role="status">
                      Sections have changed since this letter was drafted.
                    </p>
                  )}
                  </div>
                  <div className="rfpdoc-letter mt-4">
                    <p suppressHydrationWarning>{dateLabel}</p>
                    {/* "the client" when the RFP named none: the file prints
                        that fallback (resolve-draft.ts addressee), and the
                        screen shows what the file prints. */}
                    <p className="rfpdoc-letter-name mt-5">
                      {clientName?.trim() || "the client"}
                    </p>
                    {/* The addressee line above already names the client;
                        restating it read "Dear The Children's..." */}
                    <p className="mt-6">Dear evaluation team,</p>
                    {editing === LETTER_LABEL && letterSec ? (
                      <div className="rfpdoc-tool mt-4 space-y-3">
                        <span className="rfpdoc-tool-label">
                          Workspace · not in the download
                        </span>
                        <textarea
                          className="input min-h-64 w-full"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                        />
                        <p className="rfpdoc-faint text-xs">
                          Blank line between paragraphs. The facts the letter
                          rests on are kept.
                        </p>
                        <div className="rfpdoc-actions flex gap-4">
                          <button
                            type="button"
                            onClick={() => saveEdit(LETTER_LABEL)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      // .length, not ??: a cleared edit stores [] and the
                      // EXPORT falls back to the default body, so the
                      // preview must too or screen and file diverge.
                      (letterSec?.paragraphs.length
                        ? letterSec.paragraphs
                        : DEFAULT_LETTER_BODY
                      ).map((p, i) => (
                        <p className="mt-4" key={i}>
                          {p}
                        </p>
                      ))
                    )}
                    <p className="mt-6 rfpdoc-sig-person">Regards,</p>
                    <div className="rfpdoc-sig mt-5">
                      {/* The source signature does NOT bold the name. */}
                      <p className="rfpdoc-sig-person">
                        {signature.name}
                        {signature.linkedinUrl && (
                          <>
                            {" "}
                            <a
                              className="rfpdoc-sig-link"
                              href={signature.linkedinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {"{LinkedIn}"}
                            </a>
                          </>
                        )}
                      </p>
                      {signature.title && (
                        <p className="rfpdoc-sig-person">{signature.title}</p>
                      )}
                      <p className="rfpdoc-sig-contact">
                        {signature.phone
                          ? signature.fax
                            ? `${signature.phone} ph | fax ${signature.fax}`
                            : `${signature.phone} ph`
                          : ownerEmail}
                      </p>
                      <p className="mt-3">
                        <a
                          className="rfpdoc-sig-co"
                          href={COMPANY_SIGNATURE.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {COMPANY_SIGNATURE.name}
                        </a>
                      </p>
                      <p className="rfpdoc-sig-tagline">
                        <span className="rfpdoc-sig-tagline-o">
                          {COMPANY_SIGNATURE.tagline.orange}
                        </span>
                        <span className="rfpdoc-sig-tagline-n">
                          {COMPANY_SIGNATURE.tagline.navy}
                        </span>
                      </p>
                      {COMPANY_SIGNATURE.articles.map((a) => (
                        <p className="mt-2" key={a.url}>
                          <a
                            className="rfpdoc-sig-article"
                            href={a.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {a.title}
                          </a>
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
                <PageFoot />
              </section>

              {/* Part divider — the reference's numbered break page (ghost
                  numeral, bar, title, deck, three-square colophon). Claim-free
                  furniture: numerals are render-order, never RFP labels; no
                  sec-* id (a real RFP could label a section "01" and the jump
                  would collide); no flash key (nothing can update it). */}
              <DividerSheet
                num="01"
                title="Response to the Request for Proposal"
                deck="The sections of this response, as read from the request."
                clientName={coverClientName}
              />

              {structure.map((node) => {
                const sec = sections.find((s) => s.label === node.label);
                const isEditing = editing === node.label;
                const changed = highlights.has(node.label);
                const blocks = blocksByLabel.get(node.label) ?? [];
                // What "Add visual" can still offer here: one of each
                // server-built set per section, the snapshot on one section
                // in the whole document.
                const visualAdds = VISUAL_ADDS.filter(
                  (v) =>
                    !blocks.some((b) => b.origin === v.action) &&
                    !(v.action === "about" && aboutHeld)
                );
                // A Remove that failed says so under its block; anything
                // whose block is not on screen (an Add, or edit mode hiding
                // the blocks) says so under the section head instead.
                const headError =
                  visualError !== null &&
                  visualError.label === node.label &&
                  (isEditing ||
                    visualError.blockId === null ||
                    !blocks.some((b) => b.id === visualError.blockId))
                    ? visualError.message
                    : null;
                return (
                  <section
                    // An undrafted section is not in the download (the
                    // export keeps drafted sections only, resolve-draft):
                    // its sheet wears the absent field, not white paper.
                    className={`rfpdoc-page${sec ? "" : " rfpdoc-page--absent"}`}
                    key={node.label}
                    id={`sec-${node.label}`}
                  >
                  {!sec && (
                    <span className="rfpdoc-tool-label">
                      Not in the download until drafted
                    </span>
                  )}
                  <div
                    className={
                      changed ? "doc-sec--changed doc-sec--flash" : undefined
                    }
                    key={`c-${flashSeq.current.get(node.label) ?? 0}`}
                  >
                    <div className="rfpdoc-sechead">
                      <div className="min-w-0">
                        <div className="rfpdoc-kicker">{secKicker(node.label)}</div>
                        <h3 className="rfpdoc-h mt-1">
                          {node.title}
                          {changed && <span className="doc-chip">Updated</span>}
                        </h3>
                      </div>
                      <div className="rfpdoc-actions rfpdoc-tool rfpdoc-tool--row flex flex-wrap items-center gap-4">
                        {!sec ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => generate(node.label, node.title)}
                          >
                            {run?.active &&
                            run.current === `${node.label} ${node.title}`.trim()
                              ? "Drafting"
                              : "Draft this"}
                          </button>
                        ) : visualMenu === node.label && !isEditing ? (
                          <>
                            {/* The open "Add visual" choices take the row
                                over from Edit / Ask Tron / Redraft, so the
                                row never grows past one line at the lg
                                pane. Server-built visuals (no brain
                                call); one of each per section, so a
                                choice leaves once its block is there. */}
                            {visualAdds.map((v) => (
                              <button
                                key={v.action}
                                type="button"
                                disabled={visualBusy !== null}
                                onClick={() =>
                                  void changeVisual(node.label, v.action)
                                }
                              >
                                {v.add}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() => setVisualMenu(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditing(node.label);
                                setEditText(sec.paragraphs.join("\n\n"));
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => pickScope(node.label)}
                            >
                              Ask Tron
                            </button>
                            {/* The letter's redraft idiom: `force` is the
                                explicit consent to replace a hand edit. A
                                redraft carries the new draft's own
                                visuals, so hand-added ones go with the
                                old text (the edit-mode note says so). */}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                generate(node.label, node.title, true)
                              }
                            >
                              {run?.active && run.currentLabel === node.label
                                ? "Drafting"
                                : sec.generatedBy === "human"
                                  ? "Redraft (replaces your edit)"
                                  : "Redraft"}
                            </button>
                            {/* One control for every server-built visual
                                still addable here; absent while the
                                paragraphs are being edited (the blocks
                                are off screen then) and when nothing is
                                left to add. Before the timestamp, which
                                must stay last. */}
                            {!isEditing && visualAdds.length > 0 && (
                              <button
                                type="button"
                                disabled={visualBusy !== null}
                                onClick={() => setVisualMenu(node.label)}
                              >
                                {visualBusy !== null &&
                                visualBusy.startsWith(`${node.label}\u0000`) &&
                                !visualBusy.startsWith(
                                  `${node.label}\u0000remove\u0000`
                                )
                                  ? "Adding"
                                  : "Add visual"}
                              </button>
                            )}
                          </>
                        )}
                        {/* <When>, and LAST in the row, both for the
                            reasons spelled out at the cover letter's
                            timestamp above: this component is
                            server-rendered, so a bare when() mismatches
                            between the two renders; and the timestamp is the
                            one item here that changes width after mount,
                            while flex-wrap only ever displaces what follows
                            the item that grew. Ahead of Draft this / Edit /
                            Ask Tron it pushed them onto a second line on
                            every section at once. */}
                        {sec && (
                          <span className="rfpdoc-faint">
                            <When iso={sec.updatedAt} />
                          </span>
                        )}
                      </div>
                    </div>

                    {headError && (
                      <div className="rfpdoc-tool mt-2">
                        <p className="rfpdoc-visualerr" role="alert">
                          {headError}
                        </p>
                      </div>
                    )}

                    {run?.active &&
                      run.current === `${node.label} ${node.title}`.trim() &&
                      !sec && (
                        <div className="rfpdoc-tool mt-4">
                          <span className="rfpdoc-tool-label">
                            Workspace · not in the download
                          </span>
                          <p className="rfpdoc-faint text-sm" role="status">
                            Reading the section and the facts behind it. This
                            takes about a minute.
                          </p>
                        </div>
                      )}
                    {!sec && !run?.active && (
                      <div className="rfpdoc-tool mt-4">
                        <span className="rfpdoc-tool-label">
                          Workspace · not in the download
                        </span>
                        <p className="rfpdoc-faint text-sm italic">
                          Not drafted yet.{" "}
                          <button
                            type="button"
                            className="linklike"
                            disabled={busy}
                            onClick={() => generate(node.label, node.title)}
                          >
                            Draft this section
                          </button>{" "}
                          writes it from the RFP&apos;s own wording and the
                          fact base.
                        </p>
                      </div>
                    )}

                    {sec && !isEditing && (
                      <div className="mt-4 space-y-3">
                        {/* interleave() is THE ordering the gate and both
                            exporters read. Every string is a text node. */}
                        {interleave(sec.paragraphs, blocks).map((item) =>
                          item.type === "p" ? (
                            <p key={`p-${item.index}`}>{item.text}</p>
                          ) : (
                            <div className="rfpdoc-block" key={item.block.id}>
                              <DocBlock block={item.block} />
                              {/* Workspace only, never exported. */}
                              <div className="rfpdoc-actions rfpdoc-blockbar rfpdoc-tool rfpdoc-tool--row">
                                {!headError &&
                                  visualError?.label === node.label &&
                                  visualError.blockId === item.block.id && (
                                    <span role="alert">
                                      {visualError.message}
                                    </span>
                                  )}
                                {item.block.kind === "references" &&
                                  proposalId && (
                                    // Opens the picker in the Questions
                                    // pane, seeded with this block's cards.
                                    // Off wherever Remove is, and while a
                                    // draft run holds the workspace.
                                    <button
                                      type="button"
                                      disabled={visualBusy !== null || busy}
                                      aria-label={`Edit references on ${node.label}`}
                                      onClick={() => {
                                        if (item.block.kind !== "references")
                                          return;
                                        setRefsEdit({
                                          label: node.label,
                                          blockId: item.block.id,
                                          entries: item.block.references,
                                        });
                                        showPane("questions");
                                      }}
                                    >
                                      Edit references
                                    </button>
                                  )}
                                <button
                                  type="button"
                                  disabled={visualBusy !== null}
                                  aria-label={`Remove: ${draftBlockSummary(item.block).replace(" · ", ", ")}`}
                                  onClick={() =>
                                    void changeVisual(
                                      node.label,
                                      "remove",
                                      item.block.id
                                    )
                                  }
                                >
                                  {visualBusy ===
                                  `${node.label}\u0000remove\u0000${item.block.id}`
                                    ? "Removing"
                                    : "Remove"}
                                </button>
                              </div>
                            </div>
                          )
                        )}
                        {/* The section's footer tools, ONE panel: the cite
                            count and, when the draft left questions open,
                            the gaps and their Answer these. None of it is
                            in the download. */}
                        <div className="rfpdoc-tool mt-4">
                          <span className="rfpdoc-tool-label">
                            Workspace · not in the download
                          </span>
                          <p className="rfpdoc-faint text-xs">
                            {sec.cites.length} fact
                            {sec.cites.length === 1 ? "" : "s"} cited
                          </p>
                          {sec.gaps.length > 0 && (
                            <div className="mt-3">
                              <div className="rfpdoc-kicker rfpdoc-kicker--warn">
                                Needs an answer before this can go out
                              </div>
                              <ul className="mt-2 space-y-1 text-sm">
                                {sec.gaps.map((g, i) => (
                                  <li key={i}>
                                    {g.question}
                                    {/* A references why is a multi-line
                                        staff note (shortlist included):
                                        the panel shows the question only. */}
                                    {g.why &&
                                      !isReferencesQuestion(g.question) && (
                                        <span className="rfpdoc-faint"> · {g.why}</span>
                                      )}
                                  </li>
                                ))}
                              </ul>
                              <div className="rfpdoc-actions mt-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    showPane("questions");
                                  }}
                                >
                                  Answer these
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {sec && isEditing && (
                      <div className="rfpdoc-tool mt-4 space-y-3">
                        <span className="rfpdoc-tool-label">
                          Workspace · not in the download
                        </span>
                        {/* The textarea edits paragraphs only; the visuals
                            ride through the save untouched. */}
                        {blocks.length > 0 && (
                          <div className="rfpdoc-kept">
                            <p>
                              {blocks.length === 1
                                ? "1 visual stays as it is; this box edits the paragraphs only. To remove it, save or cancel, then use Remove under it. Redraft replaces it with the new draft's own."
                                : `${blocks.length} visuals stay as they are; this box edits the paragraphs only. To remove one, save or cancel, then use Remove under it. Redraft replaces them with the new draft's own.`}
                            </p>
                            <ul>
                              {blocks.map((b) => (
                                <li key={b.id}>{draftBlockSummary(b)}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <textarea
                          className="input min-h-64 w-full"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                        />
                        <p className="rfpdoc-faint text-xs">
                          Blank line between paragraphs. The facts this section
                          cites are kept.
                        </p>
                        <div className="rfpdoc-actions flex gap-4">
                          <button
                            type="button"
                            onClick={() => saveEdit(node.label)}
                          >
                            Save
                          </button>
                          <button type="button" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <PageFoot />
                  </section>
                );
              })}

              {/* The reference gives pricing its own numbered break ("04
                  Pricing & Terms" there; second break here). The deck restates
                  the engine property the empty state below already asserts. */}
              <DividerSheet
                num="02"
                title="Investment"
                deck="Pricing for the services in this proposal, computed from the rate card."
                clientName={coverClientName}
                absent={!pricing}
              />

              {/* ---- Investment: engine output, printed on the paper. The
                  flash-keyed div is INSIDE the page card so the adjust form
                  below shares the sheet without sharing the remount key.
                  Without a quote both emitters skip divider 02 and this
                  sheet (§5.17.5), so both wear the absent field until the
                  pricing questions are answered. ---- */}
              <section
                className={`rfpdoc-page${pricing ? "" : " rfpdoc-page--absent"}`}
                id="sec-__pricing"
              >
                {!pricing && (
                  <span className="rfpdoc-tool-label">
                    Not in the download until the pricing questions are answered
                  </span>
                )}
                <div
                  className={
                    highlights.has("__pricing")
                      ? "doc-sec--changed doc-sec--flash"
                      : undefined
                  }
                  key={`c-${flashSeq.current.get("__pricing") ?? 0}`}
                >
                <div className="rfpdoc-sechead">
                  <div className="min-w-0">
                    <div className="rfpdoc-kicker">Pricing</div>
                    <h3 className="rfpdoc-h mt-1">
                      Investment
                      {highlights.has("__pricing") && (
                        <span className="doc-chip">Updated</span>
                      )}
                    </h3>
                  </div>
                </div>
                {!pricing ? (
                  <div className="rfpdoc-tool mt-4">
                    <span className="rfpdoc-tool-label">
                      Workspace · not in the download
                    </span>
                    <p className="rfpdoc-faint text-sm italic">
                      Every figure here is computed from the rate card, never
                      drafted. It builds as the pricing questions are
                      answered.
                    </p>
                    <div className="rfpdoc-actions mt-2">
                      <button
                        type="button"
                        // The Questions pane opens only once a section is
                        // drafted (showPane returns early before that), so
                        // the button says so instead of doing nothing.
                        disabled={draftedCount === 0}
                        title={
                          draftedCount === 0
                            ? "Draft a section first"
                            : undefined
                        }
                        onClick={() => {
                          showPane("questions");
                        }}
                      >
                        Answer the pricing questions
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 space-y-6">
                    {pricing.illustrations.map((ill) => (
                      <div key={ill.id}>
                        <h4
                          className="rfpdoc-h"
                          style={{ fontSize: "15px" }}
                        >
                          {ill.label}
                        </h4>
                        <p className="rfpdoc-muted mt-1 text-sm">{ill.basis}</p>
                        <div className="mt-3 overflow-x-auto">
                          <table>
                            <thead>
                              <tr>
                                <th>Service</th>
                                <th style={{ textAlign: "right" }}>Qty</th>
                                <th style={{ textAlign: "right" }}>Unit</th>
                                <th style={{ textAlign: "right" }}>Monthly</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ill.lines.map((l) => (
                                <tr key={l.id}>
                                  <td>{l.label}</td>
                                  <td style={{ textAlign: "right" }}>
                                    {/* "Up to 15" on a minimum-billed fully
                                        managed line, as the export prints. */}
                                    {minimumUsers !== null
                                      ? quantityLabel(l, ill, minimumUsers)
                                      : l.quantity}
                                  </td>
                                  <td style={{ textAlign: "right" }}>
                                    {l.unitPrice.cents === 0
                                      ? ""
                                      : fmtCents(l.unitPrice.cents)}
                                  </td>
                                  <td style={{ textAlign: "right" }}>
                                    {fmtCents(l.lineTotal.cents)}
                                  </td>
                                </tr>
                              ))}
                              <tr className="rfpdoc-total">
                                <td>Monthly total</td>
                                <td />
                                <td />
                                <td style={{ textAlign: "right" }}>
                                  {fmtCents(ill.monthlyTotal.cents)}
                                </td>
                              </tr>
                              <tr className="rfpdoc-total">
                                <td>Annual total</td>
                                <td />
                                <td />
                                <td style={{ textAlign: "right" }}>
                                  {fmtCents(ill.annualTotal.cents)}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        {ill.minimumApplied && (
                          <p className="rfpdoc-caption mt-2">
                            The monthly minimum applies to the fully managed
                            line, so it is billed at the flat minimum rather
                            than the per-user product.
                          </p>
                        )}
                      </div>
                    ))}
                    {/* The file prints this sentence after the
                        illustrations whenever the minimum applied
                        (buildExportView); the screen shows the same, or the
                        download would carry a sentence the draft did not. */}
                    {pricing.illustrations.some((ill) => ill.minimumApplied) &&
                      minimumUsers !== null &&
                      minimumMonthlyCents !== null && (
                        <p className="rfpdoc-caption">
                          {minimumSentence(minimumUsers, minimumMonthlyCents)}
                        </p>
                      )}
                    {pricing.passThroughItems.map((pt) => (
                      <p className="text-sm" key={pt.label}>
                        <strong style={{ color: "#15163b" }}>{pt.label}:</strong>{" "}
                        <span className="rfpdoc-muted">{pt.detail}</span>
                      </p>
                    ))}
                    {pricing.notes.map((n, i) => (
                      <p className="rfpdoc-caption" key={i}>
                        {n}
                      </p>
                    ))}
                  </div>
                )}
                </div>

              {/* Outside the flash-keyed div: the wash remounts its key,
                  and a remount mid-edit wiped this form's state. Tool
                  chrome: the form changes the quote, it is not the quote
                  (owner 2026-09-30: it read as part of the document). */}
              {pricing && (
                <div className="rfpdoc-adjust rfpdoc-tool mt-6">
                    <span className="rfpdoc-tool-label">
                      Workspace · not in the download
                    </span>
                    <details>
                      <summary className="linklike text-sm">
                        Adjust quantities
                        {fmuSource === "rfp"
                          ? " · user count from the RFP"
                          : ""}
                      </summary>
                      <PricingForm
                        inputs={inputs}
                        busy={busy}
                        fmuSource={fmuSource}
                        onSave={async (next) => {
                          if (!proposalId) return;
                          setBusy(true);
                          const res = await fetch(
                            `/api/rfp/proposals/${proposalId}/pricing`,
                            {
                              method: "PUT",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify(next),
                            }
                          ).catch(() => null);
                          setBusy(false);
                          if (!res || !res.ok) {
                            const d = res ? await res.json().catch(() => null) : null;
                            setNotice(d?.message ?? "Not saved.");
                            return;
                          }
                          const d = await res.json();
                          // Server verdict on inputs + provenance, same as
                          // answerPricing.
                          if (d.inputs) {
                            setInputs(parseQuoteInputs(d.inputs));
                            setFmuSource(parseInputsSource(d.inputs));
                          } else {
                            setInputs(next);
                          }
                          setPricing(d.quote ?? null);
                          adoptRev(d.rev);
                          setGateResult(null);
                          showChanged(["__pricing"]);
                        }}
                      />
                    </details>
                </div>
              )}
              <PageFoot />
              </section>

              {/* Last page — the closing sheet: solid navy, white wordmark,
                  the flat-fee line, and the contact grid. */}
              <footer
                className="rfpdoc-page rfpdoc-page--sheet"
                aria-label="Closing page"
              >
                <div className="rfpdoc-navy">
                  <img
                    className="rfpdoc-navy-logo"
                    src="/brand/xlnet-logo-white-wordmark.png"
                    alt="XL.net"
                  />
                  <div>
                    <div className="rfpdoc-headline">
                      Because our fee is flat, our incentive is to prevent
                      issues, not to bill for them.
                    </div>
                    <div className="rfpdoc-bar rfpdoc-bar--blue mt-7" />
                    <p className="rfpdoc-navy-lede mt-6">
                      We welcome the opportunity to discuss this proposal
                      {/* coverClientName, as the file: the export's lede
                          names the cover's client (the proposal title when
                          the RFP named none), never the bare column. */}
                      {coverClientName ? <> with {coverClientName}</> : null}.
                    </p>
                  </div>
                  <div className="rfpdoc-meta rfpdoc-meta--navy">
                    <div>
                      <div className="rfpdoc-metalabel">Contact</div>
                      {preparedBy}
                    </div>
                    <div>
                      <div className="rfpdoc-metalabel">Email</div>
                      {ownerEmail}
                    </div>
                    <div>
                      <div className="rfpdoc-metalabel">Web</div>
                      xl.net
                    </div>
                  </div>
                </div>
                <PageFoot />
              </footer>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * One visual block on a section sheet (§5.17, draft-blocks.ts). The same
 * seven kinds both exporters draw, in the classes globals.css styles under
 * .rfpdoc. Every string is a React text node: block text is model- or
 * fact-authored and is never parsed as markup. No headings (futurism.css
 * uppercases bare h1-h3), no form state, no ids.
 */
/** The body of a branded table, as a stored `table` block or a reference
 *  card carries it (references-block.ts ReferenceCardTable is the same shape). */
type TableBody = Parameters<typeof tableColumnFractions>[0];

/** Numeric so "2. Scope" sorts before "10. Pricing"; a fixed locale so the
 *  server render and the browser agree on the order (no hydration flip). */
const SCOPE_ORDER = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

/** The Tron pane's Section pulldown, alphabetical by the text a person
 *  reads (owner directive 2026-09-30), not in drafting order. "The whole
 *  document" is not in this list: it is the default scope and stays first. */
function tronScopeOptions(
  sections: Section[]
): { value: string; text: string }[] {
  return sections
    .map((sec) => ({
      value: sec.label,
      text:
        sec.label === LETTER_LABEL ? LETTER_TITLE : `${sec.label} ${sec.title}`,
    }))
    .sort((a, b) => SCOPE_ORDER.compare(a.text, b.text));
}

/** The count the canonical references question names ("asks for three
 *  client references"), or null. Client-safe: one plain regex over the
 *  number words, no lookbehind. */
function referencesAskedCount(question: string): number | null {
  const m =
    /\basks for (one|two|three|four|five|six|seven|eight|nine|ten) client references?\b/i.exec(
      question
    );
  if (!m) return null;
  const n = [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ].indexOf(m[1].toLowerCase());
  return n >= 0 ? n + 1 : null;
}

/**
 * A branded table on the sheet. Called by DocBlock's `table` case and once
 * per card by its `references` case, so both draw byte-identical content.
 */
function renderTable(block: TableBody, asCard = false) {
  // A reference card (references-block.ts referenceCardTable): "Reference N"
  // over a blank second head cell, no caption. Its head is ONE spanning
  // header and each label cell is a row header, so a screen reader names
  // the card and reads "Organization: ..." instead of an empty column head.
  const card =
    asCard &&
    block.caption === null &&
    block.columns.length === 2 &&
    block.columns[1].header === "";
  // The SAME fractions the docx grid and the pdf columns use, so a cell
  // breaks its lines the same way on screen and in the file.
  const fractions = tableColumnFractions(block);
  const last = block.rows.length - 1;
  // The floor is the width at which every column holds its longest
  // word (a cell never splits one: overflow-wrap normal in globals.css):
  // per column the word at ~7.6px a character plus the 28px of cell
  // padding, over the column's share of the table. Capped at 640 so a
  // full sheet never scrolls; only a genuinely wide table scrolls, and
  // then inside its own wrapper. Pure arithmetic on the block, so the
  // server and the client render the same attribute.
  const minWidth = Math.min(
    640,
    Math.round(
      Math.max(
        ...fractions.map((f, c) => {
          const word = Math.max(
            longestWord(block.columns[c]?.header ?? ""),
            ...block.rows.map((r) => longestWord(r[c] ?? ""))
          );
          return (word * 7.6 + 28) / Math.max(0.05, f);
        })
      )
    )
  );
  return (
    <figure className="rfpdoc-figure">
      {block.caption && (
        <figcaption className="rfpdoc-tablecap">{block.caption}</figcaption>
      )}
      {/* Its own scroll container: a table wider than the sheet scrolls
          here, never the page; the floor above is what makes it wide. */}
      <div className="rfpdoc-tablewrap">
        {/* A card has no floor: its long email wraps inside the cell
            (globals.css .rfpdoc-refs) and the card never scrolls sideways. */}
        <table style={card ? undefined : { minWidth: `${minWidth}px` }}>
          <colgroup>
            {fractions.map((f, i) => (
              <col key={i} style={{ width: `${(f * 100).toFixed(2)}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {card ? (
                <th
                  colSpan={2}
                  scope="colgroup"
                  style={{ textAlign: block.columns[0].align }}
                >
                  {block.columns[0].header}
                </th>
              ) : (
                block.columns.map((c, i) => (
                  <th key={i} scope="col" style={{ textAlign: c.align }}>
                    {c.header}
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr
                key={r}
                className={
                  block.emphasizeLastRow && r === last
                    ? "rfpdoc-total"
                    : undefined
                }
              >
                {row.map((cell, c) =>
                  card && c === 0 ? (
                    <th
                      key={c}
                      scope="row"
                      style={{ textAlign: block.columns[c]?.align ?? "left" }}
                    >
                      {cell}
                    </th>
                  ) : (
                    <td
                      key={c}
                      style={{ textAlign: block.columns[c]?.align ?? "left" }}
                    >
                      {cell}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function DocBlock({ block }: { block: DraftBlock }) {
  switch (block.kind) {
    // role="list" on every list styled list-style: none: Safari/VoiceOver
    // drops the list semantics with the markers.
    case "stat-tiles":
      // --rfpdoc-tile-em: the em width the row's widest value needs
      // (tile-fit.ts). globals.css sizes every value in the row to fit it
      // on one line, one size for the whole row, like the files.
      return (
        <ul
          className="rfpdoc-tiles"
          role="list"
          style={
            {
              "--rfpdoc-tile-em": tileFitEm(
                block.tiles.map((t) => t.value)
              ).toFixed(3),
            } as CSSProperties
          }
        >
          {block.tiles.map((t, i) => (
            <li className="rfpdoc-tile" key={i}>
              <div className="rfpdoc-tile-value">{t.value}</div>
              <div className="rfpdoc-tile-label">{t.label}</div>
              {t.note && <div className="rfpdoc-tile-note">{t.note}</div>}
            </li>
          ))}
        </ul>
      );
    case "fact-grid":
      return (
        <dl className="rfpdoc-factgrid">
          {block.pairs.map((p, i) => (
            <div className="rfpdoc-fact" key={i}>
              <dt className="rfpdoc-fact-label">{p.label}</dt>
              <dd className="rfpdoc-fact-value">{p.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "badge-strip":
      // --rfpdoc-n: the files render n badges across for n <= 4, and so
      // does the sheet above the phone breakpoint (globals.css).
      return (
        <ul
          className="rfpdoc-badges"
          role="list"
          style={{ "--rfpdoc-n": block.badges.length } as CSSProperties}
        >
          {block.badges.map((b, i) => (
            <li className="rfpdoc-badge" key={i}>
              <span className="rfpdoc-badge-mark" aria-hidden="true" />
              <div className="min-w-0">
                <div className="rfpdoc-badge-label">{b.label}</div>
                {b.note && <div className="rfpdoc-badge-note">{b.note}</div>}
              </div>
            </li>
          ))}
        </ul>
      );
    case "table":
      return renderTable(block);
    case "references": {
      // One branded table per reference (references-block.ts), through the
      // SAME markup as a stored table so the screen matches the Word and
      // PDF cards, which the lift turns into `table` blocks.
      const cards = referenceCardTables(block.references);
      return (
        <div className="rfpdoc-refs">
          {block.references.map((_, i) => (
            <Fragment key={i}>{renderTable(cards[i], true)}</Fragment>
          ))}
        </div>
      );
    }
    case "callout":
      return (
        <div
          className={
            block.tone === "emphasis"
              ? "rfpdoc-callout rfpdoc-callout--emphasis"
              : "rfpdoc-callout"
          }
        >
          {block.title && (
            <div className="rfpdoc-callout-title">{block.title}</div>
          )}
          <p>{block.body}</p>
        </div>
      );
    case "cards":
      return (
        <div className="rfpdoc-cards">
          {block.cards.map((c, i) => (
            <div className="rfpdoc-card" key={i}>
              <div className="rfpdoc-card-title">{c.title}</div>
              <p>{c.body}</p>
              {c.footnote && <p className="rfpdoc-card-foot">{c.footnote}</p>}
            </div>
          ))}
        </div>
      );
    case "timeline":
      // Rows of up to four steps, as the files lay them (5 -> 4+1, 6 -> 4+2).
      return (
        <ol
          className="rfpdoc-timeline"
          role="list"
          style={
            { "--rfpdoc-n": Math.min(4, block.steps.length) } as CSSProperties
          }
        >
          {block.steps.map((s, i) => (
            <li className="rfpdoc-step" key={i}>
              <div className="rfpdoc-step-label">{s.label}</div>
              <div className="rfpdoc-step-title">{s.title}</div>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      );
  }
}

/** The Tron pane's note on a proposal for a section that holds visuals:
 *  a revision rewrites paragraphs only. */
function VisualsKeptNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p className="mt-3 text-xs text-faint">
      {count === 1
        ? "The 1 visual in this section is kept as it is."
        : `The ${count} visuals in this section are kept as they are.`}
    </p>
  );
}

/**
 * A numbered part-break sheet in the reference's divider style: faint
 * running header, ghost outline numeral, blue bar, Archivo title, serif
 * deck, three-square colophon. Static furniture — no id, no flash key, and
 * the numeral/squares are decorative (aria-hidden); the title carries the
 * accessible meaning.
 */
function DividerSheet({
  num,
  title,
  deck,
  clientName,
  absent = false,
}: {
  num: string;
  title: string;
  deck: string;
  clientName: string | null;
  /** The emitters skip this sheet right now (divider 02 with no pricing):
   *  it wears the tool field, not white paper, and says why. */
  absent?: boolean;
}) {
  return (
    <section
      className={`rfpdoc-page rfpdoc-page--sheet${absent ? " rfpdoc-page--absent" : ""}`}
      aria-label={`Part ${Number(num)}: ${title}`}
    >
      {absent && (
        <span className="rfpdoc-tool-label">
          Not in the download until the pricing questions are answered
        </span>
      )}
      <div className="rfpdoc-divider">
        <div className="rfpdoc-divider-head">
          XL.net · Proposal{clientName ? ` for ${clientName}` : ""}
        </div>
        <div className="rfpdoc-divider-body">
          <div className="rfpdoc-num" aria-hidden="true">
            {num}
          </div>
          <div className="rfpdoc-bar rfpdoc-bar--blue" />
          <h3 className="rfpdoc-divider-title">{title}</h3>
          <p className="rfpdoc-divider-deck">{deck}</p>
        </div>
        <div className="rfpdoc-divider-marks" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
      <PageFoot />
    </section>
  );
}

/** The handoff's per-sheet footer: hairline rule, running title, mark. */
function PageFoot() {
  return (
    <div className="rfpdoc-pagefoot">
      <div>
        <span>XL.net · Managed IT Services Proposal</span>
        <span>Confidential</span>
      </div>
    </div>
  );
}

/** Integer cents to display. Mirrors src/lib/rfp/db.ts usd(); money is never floated. */
function fmtCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${rest}`;
}

/** The monthly-minimum assumption, stated before the user count is asked. */
function MinimumNote({ floor }: { floor: { users: number; cents: number } }) {
  return (
    <p className="mt-3 text-sm">
      XL.net&apos;s monthly minimum covers up to {floor.users} fully managed
      users for {fmtCents(floor.cents)} a month. A client with {floor.users} or
      fewer people is always quoted up to {floor.users} users at that minimum.
    </p>
  );
}

/**
 * What the RFP says about staff. The quotes are the only attacker-controlled
 * strings on screen; each renders as a plain escaped text node, nothing else.
 */
function StaffEvidence({ quotes }: { quotes: string[] }) {
  return (
    <div className="mt-3 text-xs text-faint">
      <p>What the RFP says about staff:</p>
      {quotes.length === 0 ? (
        <p className="mt-1">No staff count was found in the RFP.</p>
      ) : (
        quotes.map((quote, i) => (
          <p className="mt-1" key={i}>
            “{quote}”
          </p>
        ))
      )}
    </div>
  );
}

/**
 * Provenance for the applied user count. NOT a question: never in the
 * queue, never in the open count, never a blocker for the done state — the
 * count is already applied, this row only says where it came from, shows the
 * RFP's own staff sentences, and keeps the correction one step away.
 */
function StatedStaffRow({
  count,
  source,
  statedStaff,
  staff,
  headcountOnly,
  busy,
  onAnswer,
}: {
  count: number;
  source: FmuSource;
  statedStaff: StatedStaff | null;
  staff: StaffContext;
  headcountOnly: boolean;
  busy: boolean;
  onAnswer: (
    q: Extract<OpenQuestion, { kind: "pricing" }>,
    value: number | string | boolean,
    extra?: Partial<QuoteInputs>
  ) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const { floor, range } = staff;
  const atMinimum = floor !== null && count <= floor.users;
  // Attribution follows the SERVER's provenance verdict. "rfp" is only ever
  // the exact grounded count seeded at proposal creation; anything else
  // (including legacy null) is a person's entry.
  const exact =
    source === "rfp" && statedStaff !== null && statedStaff.count === count;
  const q: Extract<OpenQuestion, { kind: "pricing" }> = {
    kind: "pricing",
    key: "p:fullyManagedUsers",
    field: "fullyManagedUsers",
    text: "How many people need full IT support (fully managed users)?",
    why: "",
    input: "number",
    prefill: count,
    // Already at the minimum: nothing for the one-tap to change. Above it
    // with the RFP itself stating the size (this exact count, or a range
    // that starts above the minimum): never offered, because one tap would
    // underquote a document-stated size.
    quick:
      floor && !atMinimum && !exact && !(range && range.lo > floor.users)
        ? {
            label: `Use up to ${floor.users} users (${fmtCents(floor.cents)} a month)`,
            value: floor.users,
            primary: false,
          }
        : undefined,
  };
  const origin = exact
    ? statedStaff.basis === "users"
      ? "the RFP states a supported user count"
      : "taken from the RFP"
    : source === "rfp"
      ? "taken from the RFP"
      : "entered by staff";
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="sys-label">Pricing basis</span>
      </div>
      <p className="mt-3 text-sm">
        {atMinimum ? (
          // The count on file stays visible: "up to" is the quoted band,
          // not the number a person or the RFP gave.
          <>
            Up to {floor.users} fully managed users at the{" "}
            {fmtCents(floor.cents)} monthly minimum. Count on file: {count},{" "}
            {origin}.
          </>
        ) : (
          <>
            Fully managed users: {count}.{" "}
            {origin.charAt(0).toUpperCase() + origin.slice(1)}.
          </>
        )}
      </p>
      {/* Collapsed HERE only: the row renders for every applied count and
          the full list would push the questions below the fold. The
          question card shows the same sentences open. */}
      <details className="mt-2 text-xs text-faint">
        <summary className="cursor-pointer">
          What the RFP says about staff ({staff.evidence.length})
        </summary>
        {staff.evidence.length === 0 ? (
          <p className="mt-1">No staff count was found in the RFP.</p>
        ) : (
          staff.evidence.map((quote, i) => (
            <p className="mt-1" key={i}>
              “{quote}”
            </p>
          ))
        )}
      </details>
      {headcountOnly ? (
        <p className="mt-2 text-xs text-faint">
          You marked this as total staff. The split question below must be
          resolved before export.
        </p>
      ) : exact && statedStaff.basis === "staff" ? (
        <p className="mt-2 text-xs text-faint">
          Stated staff is assumed to equal fully managed users. Change the
          number if the supported population differs.
        </p>
      ) : null}
      {editing ? (
        <PricingAnswer
          q={q}
          busy={busy}
          headcountOnlySet={headcountOnly}
          onAnswer={async (qq, v, extra) => {
            await onAnswer(qq, v, extra);
            setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="btn btn--text mt-2"
          onClick={() => setEditing(true)}
        >
          Change this number
        </button>
      )}
    </div>
  );
}

/**
 * A typed count as a whole number, or null. Accepts what people type for a
 * headcount: surrounding spaces, thousands commas ("1,200"), and a decimal
 * part (floored, as before). Also "up to 15" / "upto 15" / "up  to15", the way the
 * minimum is spoken (the owner typed exactly that and was refused,
 * 2026-09-30). Anything else, including trailing words, is refused rather
 * than guessed at.
 */
function parseWholeCount(raw: string): number | null {
  const m = /^(?:up\s*to\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?$/i.exec(
    raw.trim()
  );
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** The one-at-a-time pricing answer control. Sends quantities, never money. */
function PricingAnswer({
  q,
  busy,
  headcountOnlySet,
  onAnswer,
}: {
  q: Extract<OpenQuestion, { kind: "pricing" }>;
  busy: boolean;
  headcountOnlySet: boolean;
  onAnswer: (
    q: Extract<OpenQuestion, { kind: "pricing" }>,
    value: number | string | boolean,
    extra?: Partial<QuoteInputs>
  ) => Promise<void>;
}) {
  const [value, setValue] = useState<string>(
    q.prefill != null ? String(q.prefill) : ""
  );
  const [headcountOnly, setHeadcountOnly] = useState(headcountOnlySet);
  // Why the last press did nothing. The button used to go gray until the
  // box held bare digits, so "1,200" or "45 users" left a dead-looking
  // Answer button with no reason given (2026-09-30).
  const [invalid, setInvalid] = useState("");
  const isFm = q.field === "fullyManagedUsers";

  if (q.input === "choice")
    return (
      <div className="mt-4 flex flex-wrap gap-2">
        {q.choices!.map((c) => (
          <button
            key={c.value}
            type="button"
            className="btn btn--text"
            disabled={busy}
            onClick={() => void onAnswer(q, c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
    );

  if (q.input === "yesno")
    return (
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void onAnswer(q, true)}
        >
          Include it
        </button>
        <button
          type="button"
          className="btn btn--text"
          disabled={busy}
          onClick={() => void onAnswer(q, false)}
        >
          Leave it out
        </button>
      </div>
    );

  // Zero fully managed users is not a quote; every other count field keeps
  // accepting 0, which means "leave it out".
  const minimum = q.min ?? (isFm ? 1 : 0);
  const extra = isFm ? { statesHeadcountOnly: headcountOnly } : {};
  // The one-tap minimum is a supported-user count by definition ("up to N
  // fully managed users"), so it never carries the total-staff box, whatever
  // that box holds: a stale tick would turn one tap into a two-view quote
  // with an open split question.
  const quickExtra = isFm ? { statesHeadcountOnly: false } : {};
  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        const n = parseWholeCount(value);
        if (n === null) {
          setInvalid(
            value.trim() === ""
              ? "Enter a number first."
              : "Enter just the number, like 45 or 1,200."
          );
          return;
        }
        if (n < minimum) {
          setInvalid(`Enter at least ${minimum}.`);
          return;
        }
        setInvalid("");
        void onAnswer(q, n, extra);
      }}
    >
      {q.quick?.primary && (
        // The expected answer first; the box below is for the larger count.
        <>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void onAnswer(q, q.quick!.value, quickExtra)}
          >
            {q.quick.label}
          </button>
          <p className="mt-4 mb-2 text-xs text-faint">
            More than {q.quick.value} people? Enter the count.
          </p>
        </>
      )}
      <input
        className="input w-full"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid("");
        }}
        aria-label={q.text}
        aria-invalid={invalid ? true : undefined}
      />
      {invalid && (
        <p className="mt-2 text-xs" role="alert">
          {invalid}
        </p>
      )}
      {isFm && (
        <label className="mt-3 flex items-start gap-2 text-xs text-faint">
          <input
            type="checkbox"
            checked={headcountOnly}
            onChange={(e) => setHeadcountOnly(e.target.checked)}
          />
          <span>
            The RFP states total staff, not supported users (quotes two
            illustrations)
          </span>
        </label>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        {/* One primary per control: when the one-tap minimum leads, the
            typed count is the secondary path. Never disabled on validity. */}
        <button
          type="submit"
          className={q.quick?.primary ? "btn btn--text" : "btn btn--primary"}
          disabled={busy}
        >
          Answer
        </button>
        {q.quick && !q.quick.primary && (
          <button
            type="button"
            className="btn btn--text"
            disabled={busy}
            onClick={() => void onAnswer(q, q.quick!.value, quickExtra)}
          >
            {q.quick.label}
          </button>
        )}
        {q.alt && (
          <button
            type="button"
            className="btn btn--text"
            disabled={busy}
            onClick={() => void onAnswer(q, q.alt!.value, q.alt!.extra)}
          >
            {q.alt.label}
          </button>
        )}
      </div>
    </form>
  );
}

/** The adjust-everything form behind the pricing panel's disclosure. */
function PricingForm({
  inputs,
  busy,
  fmuSource,
  onSave,
}: {
  inputs: QuoteInputs;
  busy: boolean;
  fmuSource: FmuSource;
  onSave: (next: QuoteInputs) => Promise<void>;
}) {
  const [form, setForm] = useState<QuoteInputs>(inputs);
  const num = (v: string): number | null =>
    v.trim() === "" ? null : Math.max(0, Math.floor(Number(v) || 0));
  const numField = (
    label: string,
    key: keyof QuoteInputs
  ) => (
    <label className="block text-sm">
      <span className="text-faint">{label}</span>
      <input
        className="input mt-1 w-full"
        inputMode="numeric"
        value={form[key] === null ? "" : String(form[key])}
        onChange={(e) =>
          setForm((f) => ({ ...f, [key]: num(e.target.value) }))
        }
      />
    </label>
  );
  return (
    <div className="mt-4 space-y-3">
      {numField("Supported users (fully managed unless split below)", "fullyManagedUsers")}
      {fmuSource === "rfp" && (
        <p className="text-xs text-faint">
          This count was taken from the RFP text. Changing it makes it a
          staff entry.
        </p>
      )}
      <label className="flex items-start gap-2 text-xs text-faint">
        <input
          type="checkbox"
          checked={form.statesHeadcountOnly}
          onChange={(e) =>
            setForm((f) => ({ ...f, statesHeadcountOnly: e.target.checked }))
          }
        />
        <span>RFP states headcount, not supported users</span>
      </label>
      {form.statesHeadcountOnly && (
        <>
          {numField("Of those, Microsoft 365-only users (estimate)", "m365OnlyUsers")}
          <label className="flex items-start gap-2 text-xs text-faint">
            <input
              type="checkbox"
              checked={form.supportedUserSplitConfirmed}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  supportedUserSplitConfirmed: e.target.checked,
                }))
              }
            />
            <span>The client has confirmed the split</span>
          </label>
        </>
      )}
      {numField("Computers under XL Secure+", "securePlusComputers")}
      <label className="block text-sm">
        <span className="text-faint">Datto SaaS Protection</span>
        <select
          className="input mt-1 w-full"
          value={form.dattoRetention ?? ""}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              dattoRetention: (e.target.value ||
                null) as QuoteInputs["dattoRetention"],
            }))
          }
        >
          <option value="">Unanswered</option>
          <option value="1yr">1-year retention</option>
          <option value="infinite">Infinite retention</option>
          <option value="both">Present both tiers</option>
          <option value="none">Not in this quote</option>
        </select>
      </label>
      {form.dattoRetention && form.dattoRetention !== "none" &&
        numField("Datto users", "dattoUsers")}
      {numField("Vulnerability-scan sessions per year", "vulnScanSessionsPerYear")}
      <label className="flex items-start gap-2 text-xs text-faint">
        <input
          type="checkbox"
          checked={form.includeOnboarding === true}
          onChange={(e) =>
            setForm((f) => ({ ...f, includeOnboarding: e.target.checked }))
          }
        />
        <span>Include onboarding (one month of base managed service)</span>
      </label>
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        onClick={() => void onSave(form)}
      >
        Recompute
      </button>
    </div>
  );
}
