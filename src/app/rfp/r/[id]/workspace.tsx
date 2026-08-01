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

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { when } from "@/lib/rfp/time";
import type { QuoteInputs } from "@/lib/rfp/quote";
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
      /** Requires at least this value in the number input. */
      min?: number;
      /** Alternative one-click answer (e.g. "the split is confirmed"). */
      alt?: { label: string; value: number; extra: Partial<QuoteInputs> };
    }
  | {
      kind: "gap";
      key: string;
      label: string;
      sectionTitle: string;
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

function pricingQuestions(inputs: QuoteInputs): OpenQuestion[] {
  const qs: OpenQuestion[] = [];
  if (inputs.fullyManagedUsers === null)
    qs.push({
      kind: "pricing",
      key: "p:fullyManagedUsers",
      field: "fullyManagedUsers",
      text: "How many people need full IT support (fully managed users)?",
      why: "The quantity the monthly service and the monthly minimum are computed from.",
      input: "number",
    });
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
    initialInputs ?? EMPTY_INPUTS
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
  const [proposal, setProposal] = useState<{
    label: string;
    proposed: string[];
    current: string[];
    note: string;
  } | null>(null);
  const [notice, setNotice] = useState("");

  // ---- the live-update choreography (governance pattern) ----
  const [highlights, setHighlights] = useState<Set<string>>(new Set());
  const [flashKey, setFlashKey] = useState(0);

  // ---- draft-all run state ----
  const [run, setRun] = useState<{
    active: boolean;
    done: number;
    total: number;
    current: string;
    failures: string[];
  } | null>(null);
  const stopRef = useRef(false);
  const revRef = useRef(initialRev);
  // Narration for a run driven by ANOTHER tab (the status route's
  // gen.progress); a returning user must see the run, not a dead button.
  const [followProgress, setFollowProgress] = useState<string | null>(null);

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
  const totalGaps = sections.reduce((n, s) => n + s.gaps.length, 0);

  const queue: OpenQuestion[] = [
    ...pricingQuestions(inputs),
    ...sections.flatMap((s) =>
      s.gaps.map(
        (g): OpenQuestion => ({
          kind: "gap",
          key: `g:${s.label}:${g.question}`,
          label: s.label,
          sectionTitle: s.title,
          text: g.question,
          why: g.why,
        })
      )
    ),
  ];
  const open = queue.filter((q) => !skipped.has(q.key));
  const current = open[0] ?? null;
  const [answeredCount, setAnsweredCount] = useState(0);

  /**
   * Flash + rail a set of section panels, then scroll the first into view.
   * Never scrolls while the user is typing: a section landing mid-run must
   * not yank the viewport away from a textarea (the governance builder's
   * "the user may be typing" rule, applied to the window).
   */
  const showChanged = useCallback((labels: string[]) => {
    if (!labels.length) return;
    setHighlights(new Set(labels));
    setFlashKey((k) => k + 1);
    const typing = ["TEXTAREA", "INPUT"].includes(
      document.activeElement?.tagName ?? ""
    );
    if (typing) return;
    const first = labels[0];
    window.setTimeout(() => {
      const el = document.getElementById(
        first === "__pricing" ? "sec-__pricing" : `sec-${first}`
      );
      const reduce = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      el?.scrollIntoView({
        block: "start",
        behavior: reduce ? "auto" : "smooth",
      });
    }, 60);
  }, []);

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
      if (p.pricingInputs) setInputs(p.pricingInputs);
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
  }, [documentId]);

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

  /** Draft one section: 202 then poll to completion. */
  const draftOne = useCallback(
    async (
      label: string,
      title: string
    ): Promise<{ error: string | null; busy: boolean }> => {
      // Every fetch in this file goes through a rejection guard: an
      // unhandled rejection here would unwind draftAll past its cleanup and
      // freeze the workbar on "Drafting" forever.
      const res = await fetch(`/api/rfp/documents/${documentId}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sectionLabel: label, sectionTitle: title }),
      }).catch(() => null);
      if (!res)
        return { error: "The server could not be reached.", busy: false };
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        return {
          error: d?.message ?? "That section could not be drafted.",
          busy: res.status === 409,
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

  /** The CoWork loop: every undrafted section, one call at a time. */
  const draftAll = useCallback(async () => {
    const remaining = structure.filter(
      (n) => !sections.some((s) => s.label === n.label)
    );
    if (!remaining.length) return;
    stopRef.current = false;
    setBusy(true);
    setNotice("");
    const failures: string[] = [];
    let stoppedByBusy = false;
    for (let i = 0; i < remaining.length; i++) {
      if (stopRef.current) break;
      const node = remaining[i];
      setRun({
        active: true,
        done: i,
        total: remaining.length,
        current: `${node.label} ${node.title}`.trim(),
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
      if (err) failures.push(`${node.label || node.title}: ${err}`);
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

  async function generate(label: string, title: string) {
    setBusy(true);
    setNotice("");
    setRun({
      active: true,
      done: 0,
      total: 1,
      current: `${label} ${title}`.trim(),
      failures: [],
    });
    const { error: err } = await draftOne(label, title);
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
    setInputs(next);
    setPricing(d.quote ?? null);
    adoptRev(d.rev);
    setGateResult(null);
    setAnsweredCount((n) => n + 1);
    setAnswerText("");
    if (d.quote) showChanged(["__pricing"]);
  }

  /** Answer the current gap question: the brain weaves it into the section. */
  async function answerGap(q: Extract<OpenQuestion, { kind: "gap" }>) {
    if (!proposalId || answerText.trim().length < 2) return;
    setWeaving(q.key);
    setNotice("");
    const res = await fetch(`/api/rfp/proposals/${proposalId}/gap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: q.label,
        question: q.text,
        answer: answerText.trim(),
        remember,
      }),
    }).catch(() => null);
    setWeaving(null);
    if (!res) {
      // The weave is a long synchronous call; the edge can close the
      // connection while the server still lands the write. Check before
      // claiming failure.
      const st = await pollOnce();
      if (st.changed.length) {
        showChanged(st.changed);
        setNotice("The connection dropped, but the answer landed.");
        setAnswerText("");
      } else {
        setNotice(
          "The connection dropped while weaving. The answer may still land; reload in a minute if the section does not update."
        );
      }
      return;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.message ?? "The answer could not be woven in.");
      return;
    }
    const d = await res.json();
    setSections((prev) =>
      prev.map((s) => (s.label === q.label ? d.section : s))
    );
    adoptRev(d.rev);
    setGateResult(null);
    setAnsweredCount((n) => n + 1);
    setAnswerText("");
    setLastWoven(q.label);
    showChanged([q.label]);
    if (d.note) setNotice(d.note);
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
    if (res.status === 409) {
      const d = await res.json().catch(() => null);
      if (d?.gate) setGateResult(d.gate as GateResult);
      setNotice(d?.message ?? "Not ready to export yet.");
      const toQuestions = d?.openGaps > 0 || d?.pricingMissing?.length > 0;
      showPane(toQuestions ? "questions" : "checks");
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
  }

  async function saveEdit(label: string) {
    if (!proposalId) return;
    const paragraphs = editText
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
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

  async function askTron() {
    if (!proposalId || !scope || instruction.trim().length < 3) return;
    setBusy(true);
    setNotice("");
    const res = await fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: scope, instruction }),
    }).catch(() => null);
    setBusy(false);
    if (!res) {
      setNotice("The server could not be reached. Nothing has been changed.");
      return;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      setNotice(d?.message ?? "Tron did not answer. Nothing has been changed.");
      return;
    }
    const d = await res.json();
    setProposal({
      label: scope,
      proposed: d.proposed,
      current: d.current,
      note: d.note,
    });
    // The proposal card renders inside the section's panel in the doc
    // column, which is hidden on mobile and often off-screen on desktop.
    setMobile("draft");
    window.setTimeout(() => {
      document
        .getElementById(`sec-${scope}`)
        ?.scrollIntoView({ block: "start" });
    }, 60);
  }

  async function acceptProposal() {
    if (!proposal || !proposalId) return;
    const res = await fetch(`/api/rfp/proposals/${proposalId}/section`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: proposal.label,
        paragraphs: proposal.proposed,
      }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setNotice(res ? "That change was not saved." : "The server could not be reached.");
      return;
    }
    const d = await res.json().catch(() => null);
    adoptRev(d?.rev);
    setGateResult(null);
    setSections((prev) =>
      prev.map((s) =>
        s.label === proposal.label ? { ...s, paragraphs: proposal.proposed } : s
      )
    );
    showChanged([proposal.label]);
    setProposal(null);
    setInstruction("");
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
      <div className="panel mb-6 rfp-runbar">
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
                {sections.length} of {structure.length || sections.length}{" "}
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
            ) : undrafted.length > 0 ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void draftAll()}
              >
                {sections.length === 0
                  ? "Draft the whole response"
                  : `Draft the ${undrafted.length} remaining`}
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

      <div className="lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-8">
        {/* ---- the draft ---- */}
        <div
          className={`${mobile === "draft" ? "block" : "hidden"} lg:block min-w-0`}
        >
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
            <div className="space-y-6">
              {structure.map((node) => {
                const sec = sections.find((s) => s.label === node.label);
                const isEditing = editing === node.label;
                const changed = highlights.has(node.label);
                return (
                  <div
                    className={`panel${changed ? " doc-sec--changed doc-sec--flash" : ""}`}
                    key={changed ? `${node.label}-${flashKey}` : node.label}
                    id={`sec-${node.label}`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <span className="sys-label">{node.label}</span>
                        <h3 className="doc-h mt-2">
                          {node.title}
                          {changed && <span className="doc-chip">Updated</span>}
                        </h3>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {sec && (
                          <span className="text-xs text-faint">
                            {when(sec.updatedAt)}
                          </span>
                        )}
                        {!sec ? (
                          <button
                            type="button"
                            className="btn btn--text"
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
                              className="btn btn--text"
                              onClick={() => {
                                setEditing(node.label);
                                setEditText(sec.paragraphs.join("\n\n"));
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn--text"
                              onClick={() => {
                                setScope(node.label);
                                showPane("tron");
                              }}
                            >
                              Ask Tron
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {run?.active &&
                      run.current === `${node.label} ${node.title}`.trim() &&
                      !sec && (
                        <p className="mt-4 text-sm text-faint" role="status">
                          Reading the section and the facts behind it. This
                          takes about a minute.
                        </p>
                      )}

                    {sec && !isEditing && (
                      <div className="mt-4 space-y-3">
                        {sec.paragraphs.map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                        {sec.gaps.length > 0 && (
                          <div className="panel panel--lightline-sand mt-4">
                            <span className="sys-label">
                              Needs an answer before this can go out
                            </span>
                            <ul className="mt-3 space-y-2 text-sm">
                              {sec.gaps.map((g, i) => (
                                <li key={i}>
                                  {g.question}
                                  {g.why && (
                                    <span className="text-faint"> · {g.why}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                            <button
                              type="button"
                              className="btn btn--text mt-3"
                              onClick={() => {
                                showPane("questions");
                              }}
                            >
                              Answer these
                            </button>
                          </div>
                        )}
                        <p className="text-xs text-faint">
                          {sec.cites.length} fact
                          {sec.cites.length === 1 ? "" : "s"} cited
                        </p>
                      </div>
                    )}

                    {sec && isEditing && (
                      <div className="mt-4 space-y-3">
                        <textarea
                          className="input min-h-64"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                        />
                        <p className="text-xs text-faint">
                          Blank line between paragraphs. The facts this section
                          cites are kept.
                        </p>
                        <div className="flex gap-3">
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={() => saveEdit(node.label)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn btn--text"
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {proposal?.label === node.label && (
                      <div className="panel panel--raised mt-4">
                        <span className="sys-label">Tron proposed a change</span>
                        {proposal.note && (
                          <p className="mt-3 text-sm text-faint">
                            {proposal.note}
                          </p>
                        )}
                        <div className="mt-4 space-y-3">
                          {proposal.proposed.map((p, i) => (
                            <p key={i}>{p}</p>
                          ))}
                        </div>
                        <div className="mt-4 flex flex-wrap gap-3">
                          <button
                            type="button"
                            className="btn btn--primary"
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
                      </div>
                    )}
                  </div>
                );
              })}

              {/* ---- the pricing section: engine output, printed ---- */}
              <div
                className={`panel${highlights.has("__pricing") ? " doc-sec--changed doc-sec--flash" : ""}`}
                key={
                  highlights.has("__pricing")
                    ? `__pricing-${flashKey}`
                    : "__pricing"
                }
                id="sec-__pricing"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <span className="sys-label">Pricing</span>
                    <h3 className="doc-h mt-2">
                      Investment
                      {highlights.has("__pricing") && (
                        <span className="doc-chip">Updated</span>
                      )}
                    </h3>
                  </div>
                </div>
                {!pricing ? (
                  <div className="mt-4">
                    <p className="text-sm text-faint">
                      Every figure here is computed from the rate card, never
                      drafted. It builds as the pricing questions are
                      answered.
                    </p>
                    <button
                      type="button"
                      className="btn btn--text mt-3"
                      onClick={() => {
                        showPane("questions");
                      }}
                    >
                      Answer the pricing questions
                    </button>
                  </div>
                ) : (
                  <div className="mt-4 space-y-6">
                    {pricing.illustrations.map((ill) => (
                      <div key={ill.id}>
                        <h4 className="text-sm font-medium">{ill.label}</h4>
                        <p className="mt-1 text-xs text-faint">{ill.basis}</p>
                        <div className="mt-3 overflow-x-auto">
                          <table className="table text-sm">
                            <thead>
                              <tr>
                                <th className="text-left">Service</th>
                                <th className="text-right">Qty</th>
                                <th className="text-right">Unit</th>
                                <th className="text-right">Monthly</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ill.lines.map((l) => (
                                <tr key={l.id}>
                                  <td>{l.label}</td>
                                  <td className="text-right mono">
                                    {l.quantity}
                                  </td>
                                  <td className="text-right mono">
                                    {l.unitPrice.cents === 0
                                      ? ""
                                      : fmtCents(l.unitPrice.cents)}
                                  </td>
                                  <td className="text-right mono">
                                    {fmtCents(l.lineTotal.cents)}
                                  </td>
                                </tr>
                              ))}
                              <tr>
                                <td className="font-medium">Monthly total</td>
                                <td />
                                <td />
                                <td className="text-right mono font-medium">
                                  {fmtCents(ill.monthlyTotal.cents)}
                                </td>
                              </tr>
                              <tr>
                                <td className="font-medium">Annual total</td>
                                <td />
                                <td />
                                <td className="text-right mono font-medium">
                                  {fmtCents(ill.annualTotal.cents)}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        {ill.minimumApplied && (
                          <p className="mt-2 text-xs text-faint">
                            The monthly minimum applies to the fully managed
                            line, so it is billed at the flat minimum rather
                            than the per-user product.
                          </p>
                        )}
                      </div>
                    ))}
                    {pricing.passThroughItems.map((pt) => (
                      <p className="text-sm" key={pt.label}>
                        <span className="font-medium">{pt.label}</span> ·{" "}
                        <span className="text-faint">{pt.detail}</span>
                      </p>
                    ))}
                    {pricing.notes.map((n, i) => (
                      <p className="text-sm text-faint" key={i}>
                        {n}
                      </p>
                    ))}
                    <details>
                      <summary className="linklike text-sm">
                        Adjust quantities
                      </summary>
                      <PricingForm
                        inputs={inputs}
                        busy={busy}
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
                          setInputs(next);
                          setPricing(d.quote ?? null);
                          adoptRev(d.rev);
                          setGateResult(null);
                          showChanged(["__pricing"]);
                        }}
                      />
                    </details>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ---- the rail ---- */}
        <div
          className={`${mobile !== "draft" ? "block" : "hidden"} lg:block rfp-rail min-w-0 mt-8 lg:mt-0`}
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
                            window.setTimeout(() => {
                              document
                                .getElementById(`sec-${lastWoven}`)
                                ?.scrollIntoView({ block: "start" });
                            }, 60);
                          }}
                        >
                          View the section
                        </button>
                      </p>
                    )}
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="sys-label">
                        Question{" "}
                        {String(answeredCount + 1).padStart(2, "0")}
                      </span>
                      <span className="text-xs text-faint">
                        {open.length - 1} more after this
                      </span>
                    </div>
                    {current.kind === "gap" && (
                      <p className="mt-3 text-xs text-faint mono">
                        {current.label} {current.sectionTitle}
                      </p>
                    )}
                    <p className="mt-3">{current.text}</p>
                    {current.why && (
                      <p className="mt-2 text-xs text-faint">{current.why}</p>
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
                        <span className="mono">{(current as Extract<OpenQuestion, { kind: "gap" }>).label}</span>. The
                        section updates when it lands · about a minute.
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
                          className="input min-h-28"
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
                  {sections.length} of {structure.length} sections drafted
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
                    {totalGaps === 0
                      ? "The compliance rules run against the finished document before anything can leave. Run them from the bar above."
                      : `${totalGaps} open question${totalGaps === 1 ? "" : "s"} across the draft. A proposal does not go out with them open; the Questions pane walks through them.`}
                  </p>
                ) : (
                  <>
                    <p className="mt-3 text-sm">
                      {gateResult.passed
                        ? queue.length > 0
                          ? `The rules pass, but ${queue.length} open question${queue.length === 1 ? "" : "s"} still block${queue.length === 1 ? "s" : ""} export.`
                          : "Passing. Nothing blocks export."
                        : `${blocks.length} blocking finding${blocks.length === 1 ? "" : "s"}${warns.length ? ` and ${warns.length} advisory` : ""}. Export refuses until the blocking ones are fixed.`}
                    </p>
                    <div className="mt-4 space-y-3 max-h-[50vh] overflow-y-auto">
                      {[...blocks, ...warns].map((v, i) => (
                        <div key={i} className="text-sm">
                          <span
                            className={`badge${v.severity === "block" ? " badge--warn" : ""}`}
                          >
                            {v.ruleId}
                          </span>{" "}
                          {v.message}
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
                {totalGaps > 0 && gateResult && (
                  <p className="mt-4 text-sm text-faint">
                    Plus {totalGaps} open question
                    {totalGaps === 1 ? "" : "s"} on the sections, answered in
                    the Questions pane.
                  </p>
                )}
              </>
            )}

            {pane === "tron" && (
              <>
                <span className="sys-label">Ask Tron for a change</span>
                {scope ? (
                  <p className="mt-3 text-sm">
                    Scope: <span className="mono">{scope}</span>{" "}
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => setScope(null)}
                    >
                      clear
                    </button>
                  </p>
                ) : (
                  <p className="mt-3 text-sm text-faint">
                    Pick a section with &quot;Ask Tron&quot; first, so the change
                    lands somewhere specific.
                  </p>
                )}
                <textarea
                  className="input mt-4 min-h-32"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Tighten this to three sentences and lead with the response time."
                />
                <p className="mt-2 text-xs text-faint">
                  Tron can reword, tighten, and reorder. It will not add a
                  price, a contract length, or a claim the knowledge base does
                  not support.
                </p>
                <button
                  type="button"
                  className="btn btn--primary mt-4"
                  disabled={busy || !scope || instruction.trim().length < 3}
                  onClick={askTron}
                >
                  {busy ? "Thinking" : "Propose a change"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
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
        className="input"
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
  onSave,
}: {
  inputs: QuoteInputs;
  busy: boolean;
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
        className="input mt-1"
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
          className="input mt-1"
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
