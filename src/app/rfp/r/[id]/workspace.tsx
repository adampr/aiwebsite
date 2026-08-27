"use client";

// The RFP workspace client island (§5.17.1).
//
// Two columns at lg: the draft on the left, a four-pane rail on the right
// (Questions / Coverage / Checks / Tron). Below lg both columns stay MOUNTED
// and are toggled with hidden/block, so a half-typed answer survives a tab
// switch.
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

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { When } from "@/components/when";
import { LocalTime } from "@/components/local-time";
import {
  parseInputsSource,
  parseQuoteInputs,
  type FmuSource,
  type QuoteInputs,
} from "@/lib/rfp/quote";
import { parseStaffRange, type StatedStaff } from "@/lib/rfp/staff-count";
import { normalizeGapQuestion } from "@/lib/rfp/gaps";
import {
  DEFAULT_LETTER_BODY,
  DOC_LABEL,
  LETTER_LABEL,
  LETTER_TITLE,
} from "@/lib/rfp/letter";
import { COMPANY_SIGNATURE, type PersonSignature } from "@/lib/rfp/signature";
import type { PricingQuote } from "@/lib/rfp/content-model";
import type { GateResult } from "@/lib/rfp/validators/gate";

type Section = {
  label: string;
  title: string;
  paragraphs: string[];
  cites: string[];
  gaps: { question: string; why: string }[];
  generatedBy: "llm" | "human";
  updatedAt: string;
};

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
      /** Grounded RFP sentence shown as context (escaped text, never markup). */
      context?: string;
      /** Requires at least this value in the number input. */
      min?: number;
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

function pricingQuestions(
  inputs: QuoteInputs,
  statedStaff: StatedStaff | null
): OpenQuestion[] {
  const qs: OpenQuestion[] = [];
  if (inputs.fullyManagedUsers === null) {
    // An RFP that stated a single staff count never reaches here: the count
    // was seeded at proposal creation (owner ruling 2026-08-02: stated staff
    // IS the user count until staff says otherwise). A stated RANGE still
    // asks, one prefilled tap, because picking an endpoint silently would be
    // authoring a number the client anchors on. The prefill comes from the
    // SAME parse that grounded the range, never from "any big number in the
    // sentence" (a founding year or street address must not win).
    const range =
      statedStaff && statedStaff.count === null
        ? parseStaffRange(statedStaff.quote)
        : null;
    if (range)
      qs.push({
        kind: "pricing",
        key: "p:fullyManagedUsers",
        field: "fullyManagedUsers",
        text: "The RFP states a range for staff count. Which number should this quote use?",
        why: "The stated range is shown below. The larger number is prefilled. You can change the count later in the rate card.",
        input: "number",
        prefill: range.hi,
        context: statedStaff!.quote,
      });
    else
      qs.push({
        kind: "pricing",
        key: "p:fullyManagedUsers",
        field: "fullyManagedUsers",
        text: "How many people need full IT support (fully managed users)?",
        why: "The quantity the monthly service and the monthly minimum are computed from.",
        input: "number",
        // Defense for a proposal that predates extraction: the grounded
        // count is at least offered, never silently applied.
        prefill: statedStaff?.count ?? undefined,
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
  structure,
  requirements,
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
  docTitle,
  statedStaff,
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
  docTitle: string;
  statedStaff: StatedStaff | null;
  preparedBy: string;
  ownerEmail: string;
  signature: PersonSignature;
}) {
  const router = useRouter();
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
  const [pane, setPane] = useState<Pane>("questions");
  const [mobile, setMobile] = useState<"draft" | Pane>("draft");
  const showPane = useCallback(
    (k: Pane) => {
      setPane(k);
      setMobile(k);
    },
    []
  );
  const [busy, setBusy] = useState(initialBusy);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [scope, setScope] = useState<string | null>(null);
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
  const [proposal, setProposal] = useState<{
    label: string;
    proposed: string[];
    current: string[];
    note: string;
  } | null>(null);
  // ---- the whole-document flow (scope === DOC_LABEL) ----
  // One plan turn names the sections to change, then the SAME per-section
  // revise call runs on each, sequentially, collecting proposals here. Each
  // is accepted or discarded exactly like the single proposal above.
  const [docProposals, setDocProposals] = useState<
    {
      label: string;
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
  } | null>(null);
  const stopRef = useRef(false);
  const revRef = useRef(initialRev);
  // Narration for a run driven by ANOTHER tab (the status route's
  // gen.progress); a returning user must see the run, not a dead button.
  const [followProgress, setFollowProgress] = useState<string | null>(null);

  // The sticky rail and the section scroll-margins sit BELOW the sticky
  // runbar, whose height varies (notices, wrapping). Measure it into a CSS
  // variable the stylesheet offsets by; without this the two sticky
  // elements share one offset and the runbar covers the rail's tabs.
  const runbarRef = useRef<HTMLDivElement | null>(null);
  // Whether a run is live drives the runbar's MOBILE stickiness (below md
  // the full panel walled off ~46% of a phone viewport; it now scrolls
  // away unless the Stop button must stay reachable), so the measurement
  // re-applies when that flips. --rfp-runbar-h must read 0 while the bar
  // is not sticky or the tabstrip and scroll margins offset for a bar that
  // scrolled away. The section workbar IS sticky below md and taller than
  // the old hardcoded 4.5rem, so its real height is measured too.
  const runbarLive = Boolean(run?.active || followProgress);
  useEffect(() => {
    const el = runbarRef.current;
    const page = el?.closest<HTMLElement>(".rfp-page");
    if (!el || !page) return;
    const apply = () => {
      const sticky = getComputedStyle(el).position === "sticky";
      page.style.setProperty(
        "--rfp-runbar-h",
        sticky ? `${el.offsetHeight + 16}px` : "0px"
      );
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
  }, [runbarLive]);

  // ---- guided questions ----
  const [answerText, setAnswerText] = useState("");
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

  const covered = new Set(sections.map((s) => s.label));
  const undrafted = structure.filter((n) => !covered.has(n.label));
  // The letter record shares the sections array under its reserved label;
  // every count a person reads must exclude it or "18 of 17" appears.
  const letterSec = sections.find((s) => s.label === LETTER_LABEL) ?? null;
  const draftedCount = sections.filter(
    (s) => s.label !== LETTER_LABEL
  ).length;
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
  const queue: OpenQuestion[] = [
    ...pricingQuestions(inputs, statedStaff),
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
    const pane = el.closest(".rfp-docpane");
    // Desktop: the document scrolls inside its own sticky pane (the
    // governance rule — never yank the window while someone is answering).
    if (pane && window.matchMedia("(min-width: 1024px)").matches) {
      const top =
        pane.scrollTop +
        el.getBoundingClientRect().top -
        pane.getBoundingClientRect().top -
        16;
      pane.scrollTo({
        top: Math.max(top, 0),
        behavior: reduce ? "auto" : "smooth",
      });
    } else {
      el.scrollIntoView({
        block: "start",
        behavior: reduce ? "auto" : "smooth",
      });
    }
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
    (labels: string[]) => {
      if (!labels.length) return;
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
        highlightTimer.current = null;
      }, 15000);
      const typing = ["TEXTAREA", "INPUT"].includes(
        document.activeElement?.tagName ?? ""
      );
      if (typing) return;
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
          }
          return;
        }
      }
      if (alive) {
        setBusy(false);
        setFollowProgress(null);
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
    let rememberThis = remember && !rememberedRef.current.has(q.key);
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
    }
    setWeaving(null);
    setWeaveProgress(null);
    if (done.length === q.targets.length) {
      setAnsweredCount((n) => n + 1);
      setAnswerText("");
      setLastWoven(done.join(", "));
    }
  }

  async function runChecks(): Promise<GateResult | null> {
    if (!proposalId) return null;
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
    // The current state always downloads; when it went out marked as a
    // draft, say exactly why so finishing it is one glance away.
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
        `Downloaded as a WORKING DRAFT: ${parts.join(", ") || "unresolved items"} outstanding. The Questions and Checks panes walk through them.`
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

  async function askTron() {
    if (!proposalId || !scope || instruction.trim().length < 3) return;
    setTronBusy(true);
    setBusyKind(scope === DOC_LABEL ? "doc" : "section");
    setNotice("");
    setTronError("");
    setTronApplied(null);
    // A new request supersedes the open proposal; leaving it on screen with
    // a live "Use this" invites accepting section A's old text while B is
    // in flight. The doc flow's collected proposals clear for the same
    // reason.
    setProposal(null);
    clearDocFlow();
    if (scope === DOC_LABEL) {
      await askTronDoc();
      return;
    }
    const res = await postTron({ label: scope, instruction });
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
      label: scope,
      proposed: d.proposed,
      current: d.current,
      note: d.note,
    });
  }

  /** The whole-document flow: one PLAN turn names the sections to change,
   *  then the targets loop through the EXISTING per-section revise call,
   *  one at a time (never parallel: the brain semaphore has 2 slots shared
   *  with Twilio voice), same client-driven pattern as draftAll. Nothing is
   *  written; every proposal still waits for its own accept. */
  async function askTronDoc() {
    tronStopRef.current = false;
    // Captured AFTER askTron's clearDocFlow bump. Once the ref moves again
    // (scope change, another clear), this run is abandoned: no more POSTs,
    // no more writes to the doc surfaces. Only stale() may end the run with
    // the surfaces untouched, and it may clear tronBusy because a NEW ask
    // cannot start while the button is disabled on tronBusy.
    const runId = docRunIdRef.current;
    const stale = () => docRunIdRef.current !== runId;
    const res = await postTron({ label: DOC_LABEL, instruction });
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
    const targets: { label: string; directive: string }[] = Array.isArray(
      d?.plan?.targets
    )
      ? d.plan.targets
      : [];
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
    // Counts sections actually sent, not loop index: a section deleted
    // since the plan is skipped, and "(3 of 7)" jumping to "(5 of 7)"
    // reads as a lost response.
    let attempted = 0;
    for (let i = 0; i < targets.length; i++) {
      if (tronStopRef.current || stale()) break;
      const t = targets[i];
      // The plan read a snapshot; a section deleted since then (another
      // tab's redraft) just drops out of the run.
      const live = sectionsRef.current.find((s) => s.label === t.label);
      if (!live) continue;
      const display =
        live.label === LETTER_LABEL
          ? LETTER_TITLE
          : `${live.label} ${live.title}`.trim();
      setDocRun({ done: attempted, total: targets.length, current: display });
      attempted++;
      const r = await postTron({
        label: t.label,
        instruction,
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
      // sections are still thinking.
      setDocProposals((prev) => [
        ...prev,
        {
          label: t.label,
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
   * whole-document entry. Returns an error string to show, or null.
   *
   * The staleness guard: the section may have moved since Tron read it (a
   * gap answer woven in, a colleague's edit, the user's own). Accepting
   * would overwrite that silently, because the PATCH sends whole paragraphs
   * and its rev CAS only fences writes concurrent with the PATCH itself.
   */
  async function applyProposal(p: {
    label: string;
    proposed: string[];
    current: string[];
  }): Promise<string | null> {
    if (!proposalId) return "The proposal is gone. Reload the page.";
    const live = sectionsRef.current.find((x) => x.label === p.label);
    const changedSince =
      live !== undefined &&
      (live.paragraphs.length !== p.current.length ||
        live.paragraphs.some((q, i) => q !== p.current[i]));
    if (changedSince)
      return "This section changed after Tron read it. Using this would undo that change. Ask Tron again so it reads the current text; if it keeps saying this, reload the page.";
    const res = await fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: p.label,
        paragraphs: p.proposed,
      }),
    }).catch(() => null);
    if (!res || !res.ok) {
      const d = res ? await res.json().catch(() => null) : null;
      return (
        d?.message ??
        (res
          ? "That change was not saved."
          : "The server could not be reached.")
      );
    }
    const d = await res.json().catch(() => null);
    adoptRev(d?.rev);
    setGateResult(null);
    setSections((prev) =>
      prev.map((s) =>
        s.label === p.label ? { ...s, paragraphs: p.proposed } : s
      )
    );
    showChanged([p.label]);
    return null;
  }

  async function acceptProposal() {
    if (!proposal || !proposalId) return;
    const err = await applyProposal(proposal);
    if (err) {
      setTronError(err);
      return;
    }
    setTronApplied(proposal.label);
    setProposal(null);
    setInstruction("");
    setTronFile(null);
    setTronError("");
  }

  async function acceptDocProposal(label: string) {
    const entry = docProposals.find((p) => p.label === label);
    if (!entry) return;
    const err = await applyProposal(entry);
    if (err) {
      setTronError(`${tronDisplay(label)}: ${err}`);
      return;
    }
    setDocApplied((prev) => [...prev, label]);
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
        const err = await applyProposal(entry);
        if (err) {
          setTronError(`${tronDisplay(entry.label)}: ${err}`);
          return;
        }
        setDocApplied((prev) => [...prev, entry.label]);
        setDocProposals((prev) => prev.filter((p) => p.label !== entry.label));
        setDocStopped(false);
      }
      setTronError("");
    } finally {
      setDocAccepting(false);
    }
  }

  const blocks =
    gateResult?.violations.filter((v) => v.severity === "block") ?? [];
  const warns =
    gateResult?.violations.filter((v) => v.severity !== "block") ?? [];

  /* ---------------------------------------------------------------------- */

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
          live. Sticky, because the auto-scroll choreography guarantees the
          top of the page is off-viewport exactly when a notice lands or the
          stop button is needed mid-run. */}
      <div
        className={`panel mb-6 rfp-runbar${runbarLive ? " rfp-runbar--live" : ""}`}
        ref={runbarRef}
      >
        {archived && (
          <p className="mb-3 text-sm">
            <span className="badge badge--warn">Archived</span>{" "}
            This RFP is out of its owner&apos;s list. It still opens, drafts,
            and exports; an admin restores it from the Archive on Your RFPs.
          </p>
        )}
        {notice && (
          <p className="mb-3 text-sm" role="status">
            {notice}
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
              disabled={checking || !proposalId || sections.length === 0}
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
                  exports marked WORKING DRAFT
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

      {/* Mobile switcher. Both columns stay mounted below. */}
      <nav className="tabstrip tabstrip--mobile mb-4" aria-label="Workspace panes">
        {(["draft", "questions", "coverage", "checks", "tron"] as const).map(
          (k) => (
            <button
              key={k}
              type="button"
              aria-pressed={k === "draft" ? mobile === "draft" : pane === k && mobile !== "draft"}
              onClick={() => (k === "draft" ? setMobile("draft") : showPane(k))}
            >
              {k === "draft" ? "Draft" : paneButton(k)}
            </button>
          )
        )}
      </nav>

      <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-8">
        {/* ---- the rail (left at lg, like governance's question pane) ---- */}
        <div
          className={`${mobile !== "draft" ? "block" : "hidden"} lg:block rfp-rail min-w-0`}
        >
          <nav className="tabstrip tabstrip--rail" aria-label="Rail">
            {(["questions", "coverage", "checks", "tron"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={pane === k}
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
                    in the draft-first empty state. */}
                {fmuSource === "rfp" &&
                  statedStaff &&
                  inputs.fullyManagedUsers !== null &&
                  sections.length > 0 && (
                    <StatedStaffRow
                      count={inputs.fullyManagedUsers}
                      statedStaff={statedStaff}
                      headcountOnly={inputs.statesHeadcountOnly}
                      busy={busy}
                      onAnswer={answerPricing}
                    />
                  )}
                {sections.length === 0 ? (
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
                    <p className="mt-3">{current.text}</p>
                    {current.why && (
                      <p className="mt-2 text-xs text-faint">{current.why}</p>
                    )}
                    {current.kind === "pricing" && current.context && (
                      // Grounded RFP sentence, plain escaped text only.
                      <p className="mt-2 text-xs text-faint">
                        The RFP says: “{current.context}”
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
                    ) : (
                      <form
                        className="mt-4"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void answerGap(
                            current as Extract<OpenQuestion, { kind: "gap" }>
                          );
                        }}
                      >
                        <textarea
                          className="input min-h-28 w-full"
                          value={answerText}
                          onChange={(e) => setAnswerText(e.target.value)}
                          placeholder="Answer in plain language. It gets woven into the section, not pasted."
                        />
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
                        <div className="mt-4 flex flex-wrap gap-3">
                          <button
                            type="submit"
                            className="btn btn--primary"
                            disabled={answerText.trim().length < 2 || busy}
                          >
                            Answer
                          </button>
                          <button
                            type="button"
                            className="btn btn--text"
                            onClick={() => {
                              setSkipped((s) => new Set(s).add(current.key));
                              setAnswerText("");
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
                        ? "Nothing is waiting on you. Run the checks, then export."
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
                          disabled={checking}
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
                <div className="mt-4 max-h-[60vh] overflow-y-auto">
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
                      : `${gapQuestionCount} open question${gapQuestionCount === 1 ? "" : "s"} across ${gapSectionCount} section${gapSectionCount === 1 ? "" : "s"}. Until answered, exports are marked WORKING DRAFT; the Questions pane walks through them.`}
                  </p>
                ) : (
                  <>
                    <p className="mt-3 text-sm">
                      {gateResult.passed
                        ? queue.length > 0
                          ? `The rules pass. ${queue.length} open question${queue.length === 1 ? "" : "s"} remain${queue.length === 1 ? "s" : ""}; until answered, exports are marked WORKING DRAFT.`
                          : "Passing. Nothing blocks export."
                        : `${blocks.length} blocking finding${blocks.length === 1 ? "" : "s"}${warns.length ? ` and ${warns.length} advisory` : ""}. Until fixed, exports are marked WORKING DRAFT.`}
                    </p>
                    <div className="mt-4 space-y-3 max-h-[50vh] overflow-y-auto">
                      {[...blocks, ...warns].map((v, i) => (
                        <div key={i} className="text-sm">
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
                        </div>
                      ))}
                      {gateResult.errors.map((e, i) => (
                        <div key={`e${i}`} className="text-sm">
                          <span className="badge badge--warn">
                            {e.ruleId} errored
                          </span>{" "}
                          {e.message}
                        </div>
                      ))}
                    </div>
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
                    value={scope ?? ""}
                    onChange={(e) => {
                      setScope(e.target.value || null);
                      setProposal(null);
                      setTronError("");
                      setTronApplied(null);
                      // Same reason the single proposal clears: a live
                      // "Use this" over stale text invites a wrong write.
                      clearDocFlow();
                    }}
                  >
                    <option value="">Pick a section</option>
                    <option value={DOC_LABEL}>The whole document</option>
                    {sections.map((sec) => (
                      <option key={sec.label} value={sec.label}>
                        {sec.label === LETTER_LABEL
                          ? LETTER_TITLE
                          : `${sec.label} ${sec.title}`}
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
                  Tron can reword, tighten, reorder, and work from an attached
                  PDF, Word, or text file as you direct. Choosing the whole
                  document plans the change first, then proposes a revision
                  for each affected section. It will not add a price, a
                  contract length, or a claim the knowledge base does not
                  support. Images cannot be read yet.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={tronBusy || !scope || instruction.trim().length < 3}
                    onClick={askTron}
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
                {docStopped && (
                  <p className="mt-3 text-sm text-faint" role="status">
                    Stopped.{" "}
                    {/* Phrased off docApplied at RENDER time: an accept can
                        land mid-run, before this line exists, and "nothing
                        has been written" would then be false. */}
                    {docApplied.length > 0
                      ? "The sections you already used are saved; nothing else has been written."
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
                    <div className="mt-3 max-h-[40vh] space-y-3 overflow-y-auto text-sm">
                      {proposal.proposed.map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={tronBusy}
                        onClick={acceptProposal}
                      >
                        Use this
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
                        The text it replaces
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
                      <span className="sys-label">
                        Proposed for {docProposals.length} section
                        {docProposals.length === 1 ? "" : "s"}
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
                          {docAccepting ? "Using all" : "Use all"}
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
                        <div className="mt-3 max-h-[40vh] space-y-3 overflow-y-auto text-sm">
                          {p.proposed.map((q, i) => (
                            <p key={i}>{q}</p>
                          ))}
                        </div>
                        <div className="mt-4 flex flex-wrap gap-3">
                          <button
                            type="button"
                            className="btn btn--primary"
                            disabled={docAccepting}
                            onClick={() => void acceptDocProposal(p.label)}
                          >
                            Use this
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
                        <details className="mt-3">
                          <summary className="linklike text-xs">
                            The text it replaces
                          </summary>
                          <div className="mt-2 space-y-2 text-xs text-faint">
                            {p.current.map((q, i) => (
                              <p key={i}>{q}</p>
                            ))}
                          </div>
                        </details>
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
        {/* ---- the document (right at lg, like governance's doc pane).
            The RAIL precedes it in the DOM (see below-moved markup): at lg
            the visual order is rail-left/doc-right AND the keyboard order
            matches — an order-utility swap once ran focus through dozens of
            per-section buttons before the guided flow. ---- */}
        <section
          className={`${mobile === "draft" ? "block" : "hidden"} lg:block min-w-0 rfp-docpane`}
          aria-label="The document. Updates as you answer."
        >
          {/* Permanently mounted status region: the sticky receipt renders
              inside it, so a change is ANNOUNCED (the pane's aria-label
              promises "updates as you answer") and expiry empties the
              region without unmounting it. */}
          <div className="rfp-doc-receipt" role="status">
            {highlights.size > 0 && (
              <p className="mb-3 text-sm">
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
            )}
          </div>
          {structure.length === 0 ? (
            <div className="panel">
              {docStatus === "read_failed" ? (
                <p className="text-faint">
                  This RFP was saved but could not be read for its structure.
                  That is usually a brief drafting-service outage, not a
                  problem with the document. Start it again from New RFP;
                  pasting the same text works.
                </p>
              ) : docStatus !== "extracted" ? (
                <p className="text-faint" role="status">
                  Still reading this RFP. Reload in a minute; drafting starts
                  once the structure is out.
                </p>
              ) : (
                <p className="text-faint">
                  No section structure was found in this RFP. That usually
                  means it is a form to fill in rather than a document to
                  write, which this workspace cannot draft yet. The
                  requirements it did find are listed under Coverage.
                </p>
              )}
            </div>
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
                    <h3 className="rfpdoc-title mt-5">{docTitle}</h3>
                    <div className="rfpdoc-bar mt-7" />
                    <p className="rfpdoc-lede mt-6">
                      Prepared
                      {clientName ? (
                        <>
                          {" "}for <strong>{clientName}</strong>
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
                  <div className="rfpdoc-actions mt-2 flex flex-wrap items-center gap-4">
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
                          onClick={() => {
                            setScope(LETTER_LABEL);
                            showPane("tron");
                          }}
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
                  <div className="rfpdoc-letter mt-4">
                    <p suppressHydrationWarning>{dateLabel}</p>
                    {clientName && (
                      <p className="rfpdoc-letter-name mt-5">{clientName}</p>
                    )}
                    {/* The addressee line above already names the client;
                        restating it read "Dear The Children's..." */}
                    <p className="mt-6">Dear evaluation team,</p>
                    {editing === LETTER_LABEL && letterSec ? (
                      <div className="mt-4 space-y-3">
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
                clientName={clientName}
              />

              {structure.map((node) => {
                const sec = sections.find((s) => s.label === node.label);
                const isEditing = editing === node.label;
                const changed = highlights.has(node.label);
                return (
                  <section
                    className="rfpdoc-page"
                    key={node.label}
                    id={`sec-${node.label}`}
                  >
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
                      <div className="rfpdoc-actions flex flex-wrap items-center gap-4">
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
                              onClick={() => {
                                setScope(node.label);
                                showPane("tron");
                              }}
                            >
                              Ask Tron
                            </button>
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

                    {run?.active &&
                      run.current === `${node.label} ${node.title}`.trim() &&
                      !sec && (
                        <p className="rfpdoc-faint mt-4 text-sm" role="status">
                          Reading the section and the facts behind it. This
                          takes about a minute.
                        </p>
                      )}
                    {!sec && !run?.active && (
                      <p className="rfpdoc-faint mt-4 text-sm italic">
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
                    )}

                    {sec && !isEditing && (
                      <div className="mt-4 space-y-3">
                        {sec.paragraphs.map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                        {sec.gaps.length > 0 && (
                          <div className="rfpdoc-gaps mt-4">
                            <div className="rfpdoc-kicker rfpdoc-kicker--warn">
                              Needs an answer before this can go out
                            </div>
                            <ul className="mt-2 space-y-1 text-sm">
                              {sec.gaps.map((g, i) => (
                                <li key={i}>
                                  {g.question}
                                  {g.why && (
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
                        <p className="rfpdoc-faint text-xs">
                          {sec.cites.length} fact
                          {sec.cites.length === 1 ? "" : "s"} cited
                        </p>
                      </div>
                    )}

                    {sec && isEditing && (
                      <div className="mt-4 space-y-3">
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
                clientName={clientName}
              />

              {/* ---- Investment: engine output, printed on the paper. The
                  flash-keyed div is INSIDE the page card so the adjust form
                  below shares the sheet without sharing the remount key. ---- */}
              <section className="rfpdoc-page" id="sec-__pricing">
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
                  <div className="mt-4">
                    <p className="rfpdoc-faint text-sm italic">
                      Every figure here is computed from the rate card, never
                      drafted. It builds as the pricing questions are
                      answered.
                    </p>
                    <div className="rfpdoc-actions mt-2">
                      <button
                        type="button"
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
                                    {l.quantity}
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
                  and a remount mid-edit wiped this form's state. */}
              {pricing && (
                <div className="rfpdoc-adjust mt-6">
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
                      {clientName ? <> with {clientName}</> : null}.
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
}: {
  num: string;
  title: string;
  deck: string;
  clientName: string | null;
}) {
  return (
    <section
      className="rfpdoc-page rfpdoc-page--sheet"
      aria-label={`Part ${Number(num)}: ${title}`}
    >
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

/**
 * Provenance for an RFP-sourced user count. NOT a question: never in the
 * queue, never in the open count, never a blocker for the done state — the
 * count is already applied, this row only says where it came from and keeps
 * the correction one step away. The quote is the only attacker-controlled
 * string on screen; it renders as a plain escaped text node, nothing else.
 */
function StatedStaffRow({
  count,
  statedStaff,
  headcountOnly,
  busy,
  onAnswer,
}: {
  count: number;
  statedStaff: StatedStaff;
  headcountOnly: boolean;
  busy: boolean;
  onAnswer: (
    q: Extract<OpenQuestion, { kind: "pricing" }>,
    value: number | string | boolean,
    extra?: Partial<QuoteInputs>
  ) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const q: Extract<OpenQuestion, { kind: "pricing" }> = {
    kind: "pricing",
    key: "p:fullyManagedUsers",
    field: "fullyManagedUsers",
    text: "How many people need full IT support (fully managed users)?",
    why: "",
    input: "number",
    prefill: count,
  };
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="sys-label">Pricing basis</span>
      </div>
      <p className="mt-3 text-sm">
        Fully managed users: {count}.{" "}
        {statedStaff.basis === "users"
          ? "The RFP states a supported user count."
          : "Taken from the RFP."}
      </p>
      <p className="mt-2 text-xs text-faint">
        The RFP says: “{statedStaff.quote}”
      </p>
      {headcountOnly ? (
        <p className="mt-2 text-xs text-faint">
          You marked this as total staff. The split question below must be
          resolved before export.
        </p>
      ) : statedStaff.basis === "staff" ? (
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

  const minimum = q.min ?? 0;
  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(value);
        if (!Number.isFinite(n) || n < minimum) return;
        void onAnswer(
          q,
          Math.floor(n),
          isFm ? { statesHeadcountOnly: headcountOnly } : {}
        );
      }}
    >
      <input
        className="input w-full"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={q.text}
      />
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
        <button
          type="submit"
          className="btn btn--primary"
          disabled={
            busy ||
            value.trim() === "" ||
            Number(value) < minimum ||
            !Number.isFinite(Number(value))
          }
        >
          Answer
        </button>
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
