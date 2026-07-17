"use client";

// /governance/[id] workspace core (§5.12 UI). Owns the poll loop, the
// drafting/review state machine, the answer round-trip (promptId lifecycle,
// stale-tab and dropped-connection recovery), the update choreography, the
// single polite live region, and the desktop split / mobile two-tab layout.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { KIND_LABELS } from "@/lib/governance/config";
import { isChaseId } from "@/lib/governance/interview";
import { sectionTitleText } from "@/lib/governance/numbering";
import {
  diffResolvedMarkers,
  type ResolvedMarkerReveal,
} from "@/lib/governance/resolved-anim";
import {
  packRestyleBatches,
  restyleTargets,
  textContentKey,
} from "@/lib/governance/restyle";
import type {
  GovernanceDoc,
  OpenConfirmItem,
  ProjectStatus,
  ProjectView,
  TranscriptEntry,
} from "@/lib/governance/types";
import type { KeepResult } from "./open-items-resolver";
import {
  api,
  firstFeedTarget,
  fmtDate,
  isTurnAccepted,
  mintPromptId,
  parseFeedRef,
  StatusBadge,
  STATUS_META,
  toggleChipInAnswer,
  type FeedRef,
  type TurnAccepted,
  type TurnResponse,
} from "./shared";
import { ResearchScreen, researchStepLabel } from "./research-screen";
import { DocPane, secDomId, type ChangedRef, type RevealState } from "./doc-pane";
import { StyleSampleControl } from "./style-sample-control";
import {
  QuestionPane,
  type WorkingKind,
  type WorkspaceNotice,
} from "./question-pane";
import { DownloadMenu } from "./download-menu";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

/** Keys that scroll the doc pane; each signals manual reading intent. */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

function LiveRegion({ text }: { text: string }) {
  // The ONE live region on the page; content is replaced, never appended.
  return (
    <div aria-live="polite" role="status" className="sr-only">
      {text}
    </div>
  );
}

function focusSoon(ref: React.RefObject<HTMLElement | null>) {
  window.setTimeout(() => ref.current?.focus(), 80);
}

function GonePanel() {
  return (
    <div className="mx-auto max-w-xl pt-12 text-center">
      <span className="sys-label sys-label--center">AI Governance</span>
      <h1 className="mt-6 text-3xl">This project is gone</h1>
      <p className="mx-auto mt-4">
        Projects auto-delete 30 days after the last activity, and this one
        reached that line. Start a new one; the research runs fresh, which is
        usually a good thing.
      </p>
      <Link href="/governance" className="btn btn--primary mt-8 no-underline">
        Start a new project
      </Link>
    </div>
  );
}

export function Workspace({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [gone, setGone] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [pollFails, setPollFails] = useState(0);
  const [brainDown, setBrainDown] = useState(false);
  const [working, setWorking] = useState(false);
  const [workingKind, setWorkingKind] = useState<WorkingKind>("send");
  const [workingLong, setWorkingLong] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
  const [highlights, setHighlights] = useState<Record<string, string[]>>({});
  const [flashKey, setFlashKey] = useState(0);
  const [changedNow, setChangedNow] = useState<ChangedRef[] | null>(null);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"questions" | "draft">(
    "questions"
  );
  const [draftDot, setDraftDot] = useState(0);
  // Mobile Questions tab: a new question's asked-about section is waiting
  // unseen on the Draft tab (owner fix #3).
  const [askPending, setAskPending] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);
  const [answerText, setAnswerTextState] = useState("");
  const [skipPending, setSkipPending] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchError, setResearchError] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Resolved-marker reveal (owner request 2026-07-17): settled spans keep a
  // static wash until the next turn; `reveal` is the one item playing now.
  const [resolvedMarks, setResolvedMarks] = useState<ResolvedMarkerReveal[]>([]);
  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [showStatus, setShowStatus] = useState<{
    index: number;
    total: number;
  } | null>(null);
  const [showNote, setShowNote] = useState<string | null>(null);
  const [restylePassNote, setRestylePassNote] = useState("");

  const viewRef = useRef<ProjectView | null>(null);
  const pendingRef = useRef<{
    questionId: string;
    answer: string;
    skipped: boolean;
    promptId: string;
  } | null>(null);
  const inFlightRef = useRef<{
    preSendRev: number;
    token: number;
    questionId: string;
    promptId: string;
    kind: WorkingKind;
    // Resolver-batch, amend, and restyle sends never own the answer box: a
    // landed turn must not clear the user's typed-but-unsent draft.
    preserveDraft: boolean;
  } | null>(null);
  // A multi-pass restyle run (§5.12 format pass). Client-driven chaining:
  // each pass is one ordinary async turn; the next batch is re-packed from
  // the FRESH view (sections can vanish or grow under a concurrent tab).
  const restyleRunRef = useRef<{
    pendingRefs: string[]; // targets not yet sent
    changedRefs: Set<string>; // union of restyled "slug#section" refs
    pass: number;
    totalEstimate: number;
    baseline: Map<string, string>; // ref -> pre-run text content key
  } | null>(null);
  // The reveal show queue. `seq` invalidates in-flight timers on interrupt.
  const showRef = useRef<{
    items: ResolvedMarkerReveal[]; // trimmed to the time budget + item cap
    originalTotal: number; // pre-trim diff count (the overflow note's honest denominator)
    index: number;
    seq: number;
    askRef: FeedRef | null; // deferred ask-anchor park, runs after the show
    rev: number; // the rev this show belongs to; a newer rev supersedes it
  } | null>(null);
  const pendingShowRef = useRef<{
    items: ResolvedMarkerReveal[];
    askRef: FeedRef | null;
    rev: number;
  } | null>(null);
  const showTimerRef = useRef<number | null>(null);
  // fetchRef pattern: handleView (memoized) reaches the CURRENT render's
  // restyle-chaining logic through this ref, never a stale closure.
  const continueRestyleRef = useRef<(next: ProjectView) => void>(() => {});
  // jumpTo is defined before endShow; it interrupts the show through this.
  const endShowRef = useRef<(park: boolean) => void>(() => {});
  // The 20 s "Still working" timer outlives submitTurn's scope: an async-
  // accepted (202) turn resolves via the poll, possibly minutes later.
  const longTimerRef = useRef<number | null>(null);
  const reclaimedRef = useRef(false);
  const stepRef = useRef<string | null>(null);
  const stepAnnouncesRef = useRef(0);
  const questionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingJumpRef = useRef<{
    doc: string;
    section: string;
    focus: boolean;
    // Automatic choreography (changed/ask jumps) scrolls only the doc
    // pane's own container on desktop; user jumps use scrollIntoView.
    auto: boolean;
  } | null>(null);
  const askTimerRef = useRef<number | null>(null);
  const mobileTabRef = useRef(mobileTab);
  const isDesktopRef = useRef(true);
  // Bumped on every user-initiated jump; a scheduled ask-anchor scroll
  // aborts if the user moved themselves in the meantime (no scroll fights).
  const userJumpSeqRef = useRef(0);
  const fetchRef = useRef<() => Promise<ProjectView | null>>(async () => null);

  useEffect(() => {
    mobileTabRef.current = mobileTab;
  }, [mobileTab]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const apply = () => {
      setIsDesktop(mq.matches);
      isDesktopRef.current = mq.matches;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const clearDraft = useCallback(
    (qid: string) => {
      try {
        sessionStorage.removeItem(`gov:${projectId}:${qid}`);
      } catch {
        // storage unavailable: nothing to clear
      }
    },
    [projectId]
  );

  /** S4: every keystroke persists to sessionStorage under the question id.
   *  Any change also retires a stale notice (limit warning, send error). */
  const setAnswerText = useCallback(
    (text: string) => {
      setAnswerTextState(text);
      setNotice(null);
      const v = viewRef.current;
      const qid = v?.status === "review" ? "revise" : v?.nextQuestion?.id;
      if (qid) {
        try {
          sessionStorage.setItem(`gov:${projectId}:${qid}`, text);
        } catch {
          // storage unavailable: the in-memory value still stands
        }
      }
    },
    [projectId]
  );

  const setNoticeAnnounced = useCallback((n: WorkspaceNotice) => {
    setNotice(n);
    setAnnounce(n.text);
  }, []);

  const clearLongTimer = useCallback(() => {
    if (longTimerRef.current !== null) {
      window.clearTimeout(longTimerRef.current);
      longTimerRef.current = null;
    }
  }, []);

  /** One place maps a failed turn's error code to UI, byte-identical copy
   *  whether it arrived on the POST response (legacy sync path) or through
   *  the poll's turn record (async path). */
  const resolveTurnFailure = useCallback(
    (code: string, message: string) => {
      // A failed pass ends any restyle run; what landed already is kept.
      if (restyleRunRef.current) {
        restyleRunRef.current = null;
        setRestylePassNote("");
      }
      if (code === "brain_unavailable") {
        // S3: keep the typed answer; polling re-enables Send.
        setBrainDown(true);
        setAnnounce(
          "Tron's drafting engine is offline right now. Your answer is kept here; Send re-enables when he is back."
        );
        return;
      }
      if (code === "invalid_turn") {
        pendingRef.current = null; // mint a NEW promptId on the next attempt
        setNoticeAnnounced({ kind: "error", text: message });
        return;
      }
      if (code === "stale_question") {
        setNoticeAnnounced({
          kind: "info",
          text: "This question was already answered in another tab. Here is where the draft is now.",
        });
        return;
      }
      // "network" (dropped transport or an orphaned claim after a restart)
      // and anything unknown: the message says resend; the draft is intact.
      setNoticeAnnounced({ kind: "error", text: message });
    },
    [setNoticeAnnounced]
  );

  /** Suggestion chips toggle as "; "-joined segments of the answer; the
   *  textarea stays the only source of truth (string surgery lives in
   *  shared.tsx toggleChipInAnswer). */
  const toggleSuggestion = useCallback(
    (s: string) => {
      const r = toggleChipInAnswer(answerText, s);
      if (!r) return;
      if ("overLimit" in r) {
        setNoticeAnnounced({
          kind: "info",
          text: "That is the 2000 character limit. Trim your answer to add more.",
        });
        return;
      }
      setAnswerText(r.next);
    },
    [answerText, setAnswerText, setNoticeAnnounced]
  );

  const performJump = useCallback(() => {
    const p = pendingJumpRef.current;
    if (!p) return;
    pendingJumpRef.current = null;
    const el = document.getElementById(secDomId(p.doc, p.section));
    if (!el) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
    const pane = isDesktopRef.current
      ? el.closest<HTMLElement>(".docpane")
      : null;
    if (p.auto && pane) {
      // Automatic jumps never move the window on desktop (the user may be
      // typing): reposition the doc pane's own scroll container only.
      const top =
        pane.scrollTop +
        el.getBoundingClientRect().top -
        pane.getBoundingClientRect().top -
        16;
      pane.scrollTo({ top: Math.max(top, 0), behavior });
    } else {
      el.scrollIntoView({ block: "start", behavior });
    }
    if (p.focus) {
      el.querySelector<HTMLElement>("[data-sec-heading]")?.focus({
        preventScroll: true,
      });
    }
  }, []);

  /** Cancel a not-yet-fired ask-anchor scroll (user intent wins). */
  const cancelAskJump = useCallback(() => {
    if (askTimerRef.current !== null) {
      window.clearTimeout(askTimerRef.current);
      askTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => cancelAskJump(), [cancelAskJump]);

  /** S6/S11: activate the target doc tab, then scroll, then focus. */
  const jumpTo = useCallback(
    (doc: string, section: string, focus: boolean) => {
      userJumpSeqRef.current += 1;
      cancelAskJump();
      endShowRef.current(false); // user intent ends any reveal show
      pendingJumpRef.current = { doc, section, focus, auto: false };
      setActiveDoc(doc);
      if (!isDesktopRef.current) {
        setMobileTab("draft");
        setDraftDot(0);
        setAskPending(false);
      }
      window.setTimeout(performJump, 60);
    },
    [cancelAskJump, performJump]
  );

  /**
   * Owner fix #3 sequencing: after the UPDATED choreography settles, the
   * doc pane parks on the first section the new question is about (the
   * user's next task is reading that text). Aborts if the question moved
   * on, the project left drafting, or the user jumped somewhere manually.
   * Never touches keyboard focus; that stays on the question heading.
   */
  const scheduleAskJump = useCallback(
    (ref: FeedRef, delay: number) => {
      const qid = viewRef.current?.nextQuestion?.id ?? null;
      const seq = userJumpSeqRef.current;
      cancelAskJump();
      askTimerRef.current = window.setTimeout(() => {
        askTimerRef.current = null;
        const v = viewRef.current;
        if (!v || v.status !== "drafting") return;
        if (qid === null || v.nextQuestion?.id !== qid) return;
        if (userJumpSeqRef.current !== seq) return;
        pendingJumpRef.current = {
          doc: ref.doc,
          section: ref.section,
          focus: false,
          auto: true,
        };
        setActiveDoc(ref.doc);
        window.setTimeout(performJump, 60);
      }, delay);
    },
    [cancelAskJump, performJump]
  );

  /** Spec 8.4: highlights, change summary, own-container scroll, focus.
   *  The UPDATED scroll runs first; the new question's asked-about
   *  section wins the final scroll position (scheduleAskJump).
   *  opts (§5.12 additions): skipFocus = non-advancing turns (amend or
   *  restyle) never steal keyboard focus from the user's locus; deferAsk +
   *  suppressJump = a resolution reveal owns the scroll and parks the ask
   *  anchor itself when it ends; silent = intermediate restyle passes make
   *  no announcement (one receipt per run, never per pass). */
  const applyChangedChoreography = useCallback(
    (
      changed: Record<string, string[]>,
      docs: GovernanceDoc[],
      newStatus: ProjectStatus,
      prevStatus: ProjectStatus,
      askRef: FeedRef | null,
      openTotal: number,
      opts?: {
        skipFocus?: boolean;
        deferAsk?: boolean;
        suppressJump?: boolean;
        silent?: boolean;
      }
    ) => {
      const list: ChangedRef[] = [];
      for (const [dslug, secs] of Object.entries(changed)) {
        const doc = docs.find((d) => d.slug === dslug);
        for (const sid of secs) {
          // Titles must match the pane's host-numbered rendering ("4. Roles",
          // never a stored "7.2 Roles"), in jump links and announcements alike.
          const si = doc?.sections.findIndex((x) => x.id === sid) ?? -1;
          const s = si >= 0 ? doc!.sections[si] : undefined;
          list.push({
            doc: dslug,
            section: sid,
            title: s ? sectionTitleText(si + 1, s.title) : sid,
          });
        }
      }
      const asking = newStatus === "drafting" ? askRef : null;
      setHighlights(changed);
      setChangedNow(list.length ? list : null); // replaces, never stacks
      setFlashKey((k) => k + 1);
      if (!isDesktopRef.current && mobileTabRef.current === "questions") {
        if (list.length) setDraftDot(list.length);
        setAskPending(asking !== null);
      } else {
        setAskPending(false);
        if (list.length && !opts?.suppressJump) {
          pendingJumpRef.current = {
            doc: list[0].doc,
            section: list[0].section,
            focus: false,
            auto: true,
          };
          setActiveDoc(list[0].doc);
          window.setTimeout(performJump, 60);
        }
        // The changed flash (900 ms) gets its beat, then the pane settles
        // on the text under discussion. Straight there when nothing changed
        // or when reduced motion is set (no flash to wait for).
        if (asking && !opts?.deferAsk) {
          const reduce = window.matchMedia(
            "(prefers-reduced-motion: reduce)"
          ).matches;
          scheduleAskJump(asking, list.length && !reduce ? 1600 : 60);
        }
      }
      const titles = list.map((x) => x.title).join(", ");
      if (newStatus === "review" && prevStatus !== "review") {
        // Owner rule 2026-07-17: never announce readiness while open
        // [TO CONFIRM] items remain (forced or skip-release flips).
        setAnnounce(
          openTotal > 0
            ? "Tron stopped asking questions. Open items below need your confirmation before this draft can be final."
            : "Tron is done asking questions. The full draft is ready for your review."
        );
        focusSoon(reviewHeadingRef);
      } else if (newStatus === "review") {
        if (!opts?.silent)
          setAnnounce(
            list.length ? `Draft updated: ${titles}.` : "Draft unchanged."
          );
      } else {
        if (!opts?.silent)
          setAnnounce(
            list.length
              ? `Draft updated: ${titles}. Next question is ready.`
              : "Next question is ready."
          );
        if (!opts?.skipFocus) focusSoon(questionHeadingRef);
      }
    },
    [performJump, scheduleAskJump]
  );

  /* ------------------------------------------------------------------ *
   * Resolution reveal show (owner request 2026-07-17): highlight each
   * resolved [TO CONFIRM] marker, type its replacement out, hold a beat,
   * move on. Plays at most MAX_SHOW_ITEMS items; every diffed span keeps a
   * static wash regardless. Any user intent (scroll, jump, Escape, Skip, a
   * new turn, a newer rev) ends it instantly at the final state.
   * ------------------------------------------------------------------ */
  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  /** End the show. park = run the deferred ask-anchor scroll (natural
   *  completion only; interrupts mean the user moved and wins). */
  const endShow = useCallback(
    (park: boolean) => {
      const show = showRef.current;
      showRef.current = null;
      clearShowTimer();
      setReveal(null);
      setShowStatus(null);
      if (show && park && show.askRef) scheduleAskJump(show.askRef, 400);
    },
    [clearShowTimer, scheduleAskJump]
  );

  // Reveal pacing (owner rule 2026-07-17, round 2): the replacement should
  // read as text rapidly RE-WRITTEN over the marker, then rest a full
  // second. 30ms/char clamped [1200, 3600]ms; the tick stays 60ms (every
  // tick re-parses the revealing section, so shorter ticks buy legibility
  // nothing and double the render bill).
  const MAX_SHOW_ITEMS = 5;
  const SHOW_BUDGET_MS = 15_000;
  const SHOW_TICK_MS = 60;
  const typingTicks = (len: number) =>
    Math.min(60, Math.max(20, Math.ceil(len / 2)));
  /** Honest per-item time estimate with the REAL beats (same-section items
   *  skip the jump; deletion items skip typing). */
  const estimateItemMs = (
    item: ResolvedMarkerReveal,
    prev: ResolvedMarkerReveal | null
  ): number => {
    const sameSection =
      !!prev && prev.doc === item.doc && prev.section === item.section;
    const len = item.nextEnd - item.nextStart;
    return (
      (sameSection ? 60 : 420) +
      900 +
      (len === 0 ? 0 : typingTicks(len) * SHOW_TICK_MS) +
      1000
    );
  };
  const runShowStep = useCallback(() => {
    const show = showRef.current;
    if (!show) return;
    const seq = show.seq;
    const later = (ms: number, fn: () => void) => {
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        if (showRef.current?.seq === seq) fn();
      }, ms);
    };
    if (show.index >= show.items.length) {
      // Trimmed by the time budget or the item cap: the note's denominator
      // is the ORIGINAL diff count, not the trimmed list.
      if (show.originalTotal > show.items.length)
        setShowNote(
          `Showed ${show.items.length} of ${show.originalTotal} resolved items. The rest are highlighted in the draft.`
        );
      endShow(true);
      return;
    }
    const item = show.items[show.index];
    setShowStatus({
      index: show.index,
      total: show.items.length,
    });
    // Beat 1: bring the section into view (auto jump: desktop scrolls the
    // doc pane's own container only; the window never moves).
    const prevItem = show.index > 0 ? show.items[show.index - 1] : null;
    const sameSection =
      prevItem &&
      prevItem.doc === item.doc &&
      prevItem.section === item.section;
    if (!sameSection) {
      pendingJumpRef.current = {
        doc: item.doc,
        section: item.section,
        focus: false,
        auto: true,
      };
      setActiveDoc(item.doc);
      window.setTimeout(performJump, 60);
    }
    later(sameSection ? 60 : 420, () => {
      // Beat 2: the old marker, struck out on its way out. 900ms over the
      // CSS xl-resolve-out 700ms fade: the 200ms rest at settled opacity is
      // reading time (change the two numbers together, see globals.css).
      setReveal({ item, mode: "old", chars: 0 });
      later(900, () => {
        // Beat 3: the replacement re-writes itself over the marker at
        // ~30ms/char (closed-form chars so short texts still spend the
        // full floor in 1-2 char steps instead of finishing early).
        const len = item.nextEnd - item.nextStart;
        if (len === 0) {
          // Deletion only: the strike beat already showed the removal.
          setReveal({ item, mode: "hold", chars: 0 });
          later(1000, () => {
            const s = showRef.current;
            if (s) {
              s.index += 1;
              runShowStep();
            }
          });
          return;
        }
        const ticks = typingTicks(len);
        let t = 0;
        const tick = () => {
          t += 1;
          const chars = Math.min(len, Math.ceil((len * t) / ticks));
          setReveal({
            item,
            mode: t >= ticks ? "hold" : "typing",
            chars,
          });
          if (t < ticks) later(SHOW_TICK_MS, tick);
          else
            later(1000, () => {
              // Beat 4: the held rest, caret blinking, then the next item.
              const s = showRef.current;
              if (s) {
                s.index += 1;
                runShowStep();
              }
            });
        };
        tick();
      });
    });
    // estimateItemMs/typingTicks are stable module-style helpers.
     
  }, [endShow, performJump]);

  const startShow = useCallback(
    (items: ResolvedMarkerReveal[], askRef: FeedRef | null, rev: number) => {
      if (!items.length) return false;
      const reduce = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      if (reduce) {
        // Static washes only, zero motion, but the scrolls the caller
        // deferred to this show are still owed: land on the first resolved
        // section so the washes are on screen, then park the ask anchor,
        // which wins the final position (spec 8.4).
        pendingJumpRef.current = {
          doc: items[0].doc,
          section: items[0].section,
          focus: false,
          auto: true,
        };
        setActiveDoc(items[0].doc);
        window.setTimeout(performJump, 60);
        if (askRef) scheduleAskJump(askRef, 60);
        return false;
      }
      // Trim to the time budget (15s) and the item cap, always playing at
      // least one item. Estimated with the REAL beats so a same-section or
      // deletion item is not overcharged out of the show. Every diffed span
      // keeps its static wash regardless; only the theater is trimmed.
      const played: ResolvedMarkerReveal[] = [];
      let est = 0;
      for (const it of items) {
        const cost = estimateItemMs(it, played[played.length - 1] ?? null);
        if (played.length >= MAX_SHOW_ITEMS) break;
        if (played.length > 0 && est + cost > SHOW_BUDGET_MS) break;
        played.push(it);
        est += cost;
      }
      showRef.current = {
        items: played,
        originalTotal: items.length,
        index: 0,
        seq: (showRef.current?.seq ?? 0) + 1,
        askRef,
        rev,
      };
      setShowNote(null);
      runShowStep();
      return true;
    },
    // estimateItemMs and the caps are stable module-style helpers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runShowStep, performJump, scheduleAskJump]
  );

  useEffect(() => {
    endShowRef.current = endShow;
  }, [endShow]);

  // Escape ends the show anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showRef.current) endShow(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [endShow]);

  useEffect(() => () => clearShowTimer(), [clearShowTimer]);

  const handleView = useCallback(
    (next: ProjectView) => {
      const prev = viewRef.current;
      viewRef.current = next;
      setView(next);
      setPollFails(0);
      // S3: a successful GET after a brain outage re-enables Send. Lives
      // here (not in fetchProject) so the poll-surfaced brain_unavailable
      // failure below can re-set the gate and win the render batch.
      setBrainDown(false);
      setActiveDoc((cur) =>
        cur && next.documents.some((d) => d.slug === cur)
          ? cur
          : (next.documents[0]?.slug ?? null)
      );

      // N3: research announcements are step transitions only, max 4.
      if (next.status === "researching" && next.researchProgress) {
        const step = next.researchProgress.step;
        if (stepRef.current !== step) {
          stepRef.current = step;
          if (stepAnnouncesRef.current < 4) {
            stepAnnouncesRef.current += 1;
            setAnnounce(
              `Research step: ${researchStepLabel(step, next.domain)}.`
            );
          }
        }
      }

      // Any rev change invalidates the previous turn's resolved-marker
      // washes and any reveal in progress: their offsets refer to documents
      // that no longer exist. A new diff below may set fresh ones.
      if (prev && next.rev !== prev.rev) {
        endShow(false);
        pendingShowRef.current = null;
        setResolvedMarks([]);
        setShowNote(null);
      }

      // An in-flight turn that landed while the response was lost (S7): the
      // poll sees the advanced rev and renders the turn as success.
      const flight = inFlightRef.current;
      let choreographed = false;
      if (prev && flight && next.rev > flight.preSendRev) {
        inFlightRef.current = null;
        pendingRef.current = null;
        if (!flight.preserveDraft) clearDraft(flight.questionId);
        clearLongTimer();
        setWorking(false);
        setBrainDown(false);
        // Owner request 2026-07-17: markers this turn resolved get the
        // reveal show; the diff is honest by construction (committed text
        // only, anchor misses degrade to the plain Updated treatment).
        const reveals = diffResolvedMarkers(
          prev.documents,
          next.documents,
          next.changedSections
        );
        // Snapshot questions review the research block IN the card; the
        // ask anchor would spotlight an unrelated section (owner bug
        // 2026-07-17: a random highlighted marker read as the question's
        // subject). Suppressed at every askRef source site.
        const askRef =
          next.nextQuestion && !next.nextQuestion.snapshot
            ? firstFeedTarget(next.nextQuestion.feeds, next.documents)
            : null;
        const run = restyleRunRef.current;
        const intermediatePass =
          flight.kind === "restyle" && !!run && run.pendingRefs.length > 0;
        applyChangedChoreography(
          next.changedSections,
          next.documents,
          next.status,
          prev.status,
          askRef,
          next.openConfirmTotal ?? next.openConfirmItems.length,
          {
            skipFocus: flight.kind === "restyle" || flight.kind === "amend",
            deferAsk: reveals.length > 0,
            suppressJump: reveals.length > 0,
            silent: intermediatePass,
          }
        );
        if (reveals.length) {
          setResolvedMarks(reveals);
          if (!isDesktopRef.current && mobileTabRef.current === "questions") {
            // Never auto-switch tabs: the show queues and plays when the
            // user opens the Draft tab (superseded by any newer rev).
            pendingShowRef.current = { items: reveals, askRef, rev: next.rev };
          } else {
            startShow(reveals, askRef, next.rev);
          }
        }
        if (flight.kind === "amend")
          setAnnounce(
            Object.keys(next.changedSections).length
              ? "Answer changed. The draft is updated."
              : "Answer changed. Nothing in the draft needed to move."
          );
        if (flight.kind === "restyle") continueRestyleRef.current(next);
        if (flight.preserveDraft && flight.kind === "resolve") {
          // Resolver-batch receipt: the TRUE open-item count delta, never
          // per-item claims (the model may reword a marker instead of
          // deleting it; a reworded marker is a new item, not a resolved
          // one). Replaces the choreography's generic line in this render.
          const preTotal =
            prev.openConfirmTotal ?? prev.openConfirmItems.length;
          const newTotal =
            next.openConfirmTotal ?? next.openConfirmItems.length;
          const resolved = Math.max(0, preTotal - newTotal);
          setAnnounce(
            newTotal === 0
              ? "Draft updated. Every open item is resolved; you can confirm the final draft."
              : newTotal > preTotal
                ? `Draft updated. ${newTotal - preTotal} new open ${newTotal - preTotal === 1 ? "item" : "items"} appeared; ${newTotal} to go. New facts sometimes surface new assumptions.`
                : resolved > 0
                  ? `Draft updated. ${resolved} open ${resolved === 1 ? "item" : "items"} resolved, ${newTotal} to go.`
                  : `Draft updated. No open items resolved this time; ${newTotal} to go.`
          );
        }
        choreographed = true;
      }

      // The async-turn failure path: our accepted turn recorded an error
      // (or its claim aged out after a restart) and rev never advanced.
      // promptId must match - a stale failure record from an earlier turn
      // must not resolve this flight.
      if (
        !choreographed &&
        flight &&
        next.rev <= flight.preSendRev &&
        next.turn?.phase === "failed" &&
        next.turn.promptId === flight.promptId
      ) {
        inFlightRef.current = null;
        clearLongTimer();
        setWorking(false);
        resolveTurnFailure(next.turn.error.code, next.turn.error.message);
      }

      if (!choreographed && prev && prev.status !== next.status) {
        if (
          next.status === "drafting" &&
          (prev.status === "researching" ||
            prev.status === "queued" ||
            prev.status === "created" ||
            prev.status === "research_failed")
        ) {
          // S8: the researching -> drafting transition.
          setAnnounce("Research done. First question is ready.");
          setHighlights(next.changedSections);
          focusSoon(questionHeadingRef);
          // The very first question anchors too: show the researched text
          // it is about (owner fix #3), without touching focus. EXCEPT
          // snapshot questions (UP-01/N-01): their object of review is the
          // research block in the card, and anchoring purpose-scope put an
          // unrelated highlighted marker under the user's eye (owner bug
          // 2026-07-17).
          const askRef =
            next.nextQuestion && !next.nextQuestion.snapshot
              ? firstFeedTarget(next.nextQuestion.feeds, next.documents)
              : null;
          if (askRef) {
            if (!isDesktopRef.current && mobileTabRef.current === "questions") {
              setAskPending(true);
            } else {
              scheduleAskJump(askRef, 60);
            }
          }
        } else if (next.status === "review") {
          setAnnounce(
            (next.openConfirmTotal ?? next.openConfirmItems.length) > 0
              ? "Tron stopped asking questions. Open items below need your confirmation before this draft can be final."
              : "Tron is done asking questions. The full draft is ready for your review."
          );
          focusSoon(reviewHeadingRef);
        }
      }

      // A rev advanced by another tab while we are idle: refresh highlights.
      if (
        !choreographed &&
        prev &&
        next.rev > prev.rev &&
        !inFlightRef.current &&
        (next.status === "drafting" || next.status === "review")
      ) {
        setHighlights(next.changedSections);
      }

      // Initial load of an in-progress project: show the server's last
      // changed sections (chips persist until the next update).
      if (!prev && (next.status === "drafting" || next.status === "review")) {
        setHighlights(next.changedSections);
      }

      // B1: claim a queued / stale-researching row once per page load.
      if (
        !reclaimedRef.current &&
        next.reclaimable &&
        (next.status === "queued" || next.status === "researching")
      ) {
        reclaimedRef.current = true;
        setResuming(true);
        void api<{ status: string }>(
          `/api/governance/projects/${encodeURIComponent(next.id)}/research`,
          { method: "POST", body: "{}" }
        ).then(() => {
          setResuming(false);
          void fetchRef.current();
        });
      }
    },
    [
      applyChangedChoreography,
      clearDraft,
      clearLongTimer,
      endShow,
      resolveTurnFailure,
      scheduleAskJump,
      startShow,
    ]
  );

  const fetchProject = useCallback(async (): Promise<ProjectView | null> => {
    const r = await api<ProjectView>(
      `/api/governance/projects/${encodeURIComponent(projectId)}`
    );
    if (r.ok) {
      handleView(r.data); // also clears brainDown (S3) unless it re-sets it
      setSignedOut(false);
      return r.data;
    }
    if (r.status === 401) setSignedOut(true);
    else if (r.status === 404) setGone(true);
    else setPollFails((f) => f + 1);
    return null;
  }, [projectId, handleView]);

  useEffect(() => {
    fetchRef.current = fetchProject;
  }, [fetchProject]);

  useEffect(() => {
    const t = window.setTimeout(() => void fetchRef.current(), 0);
    return () => window.clearTimeout(t);
  }, []);

  // Poll loop: 3 s through created/queued/researching; in drafting/review it
  // runs while our send is in flight (3 s - the poll is the async turn's
  // resolution path), while another tab's turn is running (8 s), or during a
  // brain-down recheck (15 s); plus a retry cadence after poll failures.
  // Budget: the GET limit is 60/min/user; only the flight-owning tab polls
  // fast (20/min), so a few open tabs stay well under it.
  const loaded = view !== null;
  const status = view?.status ?? null;
  const turnRunning = view?.turn?.phase === "running";
  useEffect(() => {
    if (gone || signedOut) return;
    let ms: number | null = null;
    if (!loaded) ms = 3000;
    else if (
      status === "created" ||
      status === "queued" ||
      status === "researching"
    )
      ms = 3000;
    else if (working) ms = 3000;
    else if (turnRunning) ms = 8000;
    else if (brainDown) ms = 15_000;
    else if (pollFails > 0) ms = 8000;
    if (ms === null) return;
    const t = window.setInterval(() => void fetchProject(), ms);
    return () => window.clearInterval(t);
  }, [loaded, status, turnRunning, working, brainDown, pollFails, gone, signedOut, fetchProject]);

  // Poll again on window focus.
  useEffect(() => {
    const onFocus = () => {
      if (!gone && !signedOut) void fetchProject();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchProject, gone, signedOut]);

  // Restore the unsent draft for the current question (S4).
  const currentQid = view
    ? view.status === "review"
      ? "revise"
      : (view.nextQuestion?.id ?? null)
    : null;
  useEffect(() => {
    if (!currentQid) return;
    const t = window.setTimeout(() => {
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem(`gov:${projectId}:${currentQid}`);
      } catch {
        // storage unavailable
      }
      setAnswerTextState(saved ?? "");
      setSkipPending(false);
    }, 0);
    return () => window.clearTimeout(t);
  }, [currentQid, projectId]);

  // Owner fix #3: the sections the ACTIVE question is about, derived from
  // nextQuestion.feeds. Clears itself when the question changes or the
  // project leaves drafting. Snapshot questions mark nothing: their object
  // of review is the research block in the card, and the dashed frame on an
  // unrelated section misled the owner (bug 2026-07-17).
  const asking = useMemo(() => {
    const map: Record<string, string[]> = {};
    if (
      view &&
      view.status === "drafting" &&
      view.nextQuestion &&
      !view.nextQuestion.snapshot
    ) {
      for (const f of view.nextQuestion.feeds) {
        const ref = parseFeedRef(f);
        if (!ref) continue;
        if (!map[ref.doc]) map[ref.doc] = [];
        map[ref.doc].push(ref.section);
      }
    }
    return map;
  }, [view]);

  // Owner request 2026-07-17: the first chase question after the planned
  // bank flips the counter's unit from "about N to go" to "N open items
  // left". Show a one-time bridge line that explains the seam instead of
  // hiding it. "First" is pinned per tab in sessionStorage (the S4 pattern):
  // the key stores WHICH chase question the bridge belongs to, so re-renders,
  // StrictMode remounts, and reloads on that same question keep it up, while
  // any later chase question (including an amend's re-picked one, which
  // carries a new rev id) retires it for good.
  const chaseQid =
    view && view.status === "drafting" && view.nextQuestion
      ? view.nextQuestion.id
      : null;
  const [chaseBridge, setChaseBridge] = useState(false);
  useEffect(() => {
    // Deferred like the S4 restore above (the repo's pattern for state that
    // follows the view without cascading renders); StrictMode's double run
    // collapses to one shot via the cleanup.
    const t = window.setTimeout(() => {
      if (!isChaseId(chaseQid)) {
        setChaseBridge(false);
        return;
      }
      const key = `gov:${projectId}:chaseBridge`;
      let stored: string | null = null;
      try {
        stored = sessionStorage.getItem(key);
      } catch {
        // storage unavailable: the line degrades to showing per chase question
      }
      if (stored === null) {
        try {
          sessionStorage.setItem(key, chaseQid);
        } catch {
          // same degradation
        }
        // Screen-reader parity: the visible line sits above the focused
        // question heading, so reading forward from focus never meets it.
        // One self-contained REPLACEMENT announcement (the live region
        // never appends) carrying the fact that matters: the unit changed.
        setAnnounce(
          "Tron's planned questions are done. The count from here is open items in the draft, not questions. The next question is ready."
        );
      }
      setChaseBridge(stored === null || stored === chaseQid);
    }, 0);
    return () => window.clearTimeout(t);
  }, [chaseQid, projectId]);

  function applyTurn(
    data: TurnResponse,
    questionId: string,
    skipped: boolean,
    answer: string
  ) {
    const prev = viewRef.current;
    if (!prev) return;
    const nowIso = new Date().toISOString();
    // Non-advancing turns (restyle/amend): no local transcript fabrication
    // (the server appended the real row; the next GET delivers it) and no
    // answersCount bump. This path is mid-deploy defense only.
    const nonAdvancing = questionId === "restyle" || questionId === "amend";
    const entry: TranscriptEntry | null = nonAdvancing
      ? null
      : {
          qId: questionId,
          bankId:
            questionId === "revise" ? null : (prev.nextQuestion?.bankId ?? null),
          q:
            questionId === "revise"
              ? "Revision request"
              : (prev.nextQuestion?.text ?? ""),
          a: skipped ? "" : answer,
          skipped,
          askedAt: nowIso,
          answeredAt: nowIso,
        };
    const next: ProjectView = {
      ...prev,
      rev: data.rev,
      status: data.status,
      documents: data.documents,
      nextQuestion: data.nextQuestion,
      reviewSummary: data.reviewSummary,
      changedSections: data.changedSections,
      // Same-render update so a freshly drafted section swaps Planned for
      // Updated immediately (no idle poll exists in drafting to fix it).
      placeholderSections: data.placeholderSections ?? prev.placeholderSections,
      progress: data.progress,
      openConfirmItems: data.openConfirmItems,
      openConfirmTotal: data.openConfirmTotal ?? data.openConfirmItems.length,
      transcript: entry ? [...prev.transcript, entry] : prev.transcript,
      answersCount:
        prev.answersCount +
        (questionId === "revise" || nonAdvancing ? 0 : 1),
    };
    viewRef.current = next;
    setView(next);
    setWorking(false);
    applyChangedChoreography(
      data.changedSections,
      data.documents,
      data.status,
      prev.status,
      // Mid-deploy sync path only; the TurnResponse question carries no
      // view-derived snapshot flag, but a snapshot question is always Q1
      // (delivered by handoff + GET), so this site cannot regress the
      // suppression in practice. Kept consistent anyway.
      data.nextQuestion && !data.nextQuestion.snapshot
        ? firstFeedTarget(data.nextQuestion.feeds, data.documents)
        : null,
      data.openConfirmTotal ?? data.openConfirmItems.length
    );
  }

  async function submitTurn(opts: {
    skipped: boolean;
    // Open-item resolver batches: a composed message that bypasses the
    // revise textarea (and its sessionStorage draft) entirely, plus the
    // "slug#section" refs the server serializes verbatim in the prompt.
    message?: string;
    focusSections?: string[];
    // Restyle pass (§5.12 format pass): empty answer, batch in focusSections.
    restyle?: boolean;
    // Amend (§5.12): correct the transcript entry at this index.
    amendIndex?: number;
    amendAnswer?: string;
  }) {
    const v = viewRef.current;
    // Guard on the ref, not `working` state: the restyle chain reaches here
    // through continueRestyleRef + setTimeout, whose closure predates the
    // landing turn's setWorking(false) and would see a stale `working` true.
    if (!v || inFlightRef.current) return;
    const restyle = !!opts.restyle;
    const amend = opts.amendIndex !== undefined;
    const revise = v.status === "review" && !restyle && !amend;
    const isResolver = revise && !!opts.message;
    const questionId = restyle
      ? "restyle"
      : amend
        ? "amend"
        : revise
          ? "revise"
          : v.nextQuestion?.id;
    if (!questionId) return;
    const answer = restyle
      ? ""
      : amend
        ? (opts.amendAnswer ?? "").trim()
        : (opts.message ?? (opts.skipped ? "" : answerText.trim()));
    if (!opts.skipped && !answer && !restyle) return;
    const preOpenTotal = v.openConfirmTotal ?? v.openConfirmItems.length;

    // promptId lifecycle: reuse only for a transport retry of the SAME
    // answer; anything else mints fresh.
    const p = pendingRef.current;
    const promptId =
      p &&
      p.questionId === questionId &&
      p.answer === answer &&
      p.skipped === opts.skipped
        ? p.promptId
        : mintPromptId();
    pendingRef.current = { questionId, answer, skipped: opts.skipped, promptId };

    // A new turn supersedes any still-pending ask-anchor scroll or reveal.
    cancelAskJump();
    endShow(false);

    const token = Date.now() + Math.random();
    const kind: WorkingKind = restyle
      ? "restyle"
      : amend
        ? "amend"
        : revise
          ? isResolver
            ? "resolve"
            : "revise"
          : opts.skipped
            ? "skip"
            : "send";
    inFlightRef.current = {
      preSendRev: v.rev,
      token,
      questionId,
      promptId,
      kind,
      preserveDraft: isResolver || restyle || amend,
    };
    setWorking(true);
    setWorkingKind(kind);
    setWorkingLong(false);
    setNotice(null);
    setSkipPending(false);
    // The click's instant receipt: the button just disabled under the
    // user's focus, so the live region confirms the send took.
    if (kind === "amend")
      setAnnounce("New answer sent. Tron is reworking the draft.");
    else if (kind !== "restyle")
      // Restyle runs announce once at start (startRestyle), never per pass.
      setAnnounce(
        kind === "skip"
          ? questionId.startsWith("qi_")
            ? "Question skipped. Moving the draft to review."
            : "Question skipped. Tron is drafting a default."
          : kind === "resolve"
            ? "Answers sent. Tron is folding them in."
            : kind === "revise"
              ? "Revision sent."
              : "Answer sent."
      );
    // Armed until the turn resolves (success, failure, or superseded) -
    // an async-accepted turn keeps drafting long after the POST returns.
    clearLongTimer();
    longTimerRef.current = window.setTimeout(() => {
      setWorkingLong(true);
      setAnnounce("Still working on the draft.");
    }, 20_000);

    const r = await api<TurnResponse | TurnAccepted>(
      `/api/governance/projects/${encodeURIComponent(projectId)}/answer`,
      {
        method: "POST",
        body: JSON.stringify({
          questionId,
          answer,
          skipped: opts.skipped || undefined,
          promptId,
          mode: "async",
          focusSections: opts.focusSections?.length
            ? opts.focusSections
            : undefined,
          amendIndex: opts.amendIndex,
        }),
      }
    );

    const flight = inFlightRef.current;
    if (!flight || flight.token !== token) return; // a poll already resolved it

    if (r.ok) {
      if (isTurnAccepted(r.data)) {
        // 202: the worker is drafting server-side. The poll resolves the
        // flight - rev advance is success (S7 choreography), a matching
        // failed turn record is the error path. Spinner stays on.
        return;
      }
      // Full TurnResponse: no current server sends one (every accept is a
      // 202), but the sync-apply path stays as mid-deploy defense.
      clearLongTimer();
      inFlightRef.current = null;
      pendingRef.current = null;
      if (!isResolver && !restyle && !amend) clearDraft(questionId);
      applyTurn(r.data, questionId, opts.skipped, answer);
      if (isResolver) {
        // Honest resolver receipt: the TRUE count delta, never per-item
        // claims (the model may reword a marker instead of deleting it, and
        // a reworded marker is a new item, not a resolved one). Replaces the
        // choreography's generic announcement in the same render.
        const newTotal =
          r.data.openConfirmTotal ?? r.data.openConfirmItems.length;
        const resolved = Math.max(0, preOpenTotal - newTotal);
        setAnnounce(
          newTotal === 0
            ? "Draft updated. Every open item is resolved; you can confirm the final draft."
            : newTotal > preOpenTotal
              ? `Draft updated. ${newTotal - preOpenTotal} new open ${newTotal - preOpenTotal === 1 ? "item" : "items"} appeared; ${newTotal} to go. New facts sometimes surface new assumptions.`
              : resolved > 0
                ? `Draft updated. ${resolved} open ${resolved === 1 ? "item" : "items"} resolved, ${newTotal} to go.`
                : `Draft updated. No open items resolved this time; ${newTotal} to go.`
        );
      }
      return;
    }

    if (r.code === "stale_question" || r.code === "network") {
      // First refetch; if rev advanced past the pre-send rev, the turn (or
      // another tab's turn) landed and handleView already rendered it.
      await fetchProject();
      if (inFlightRef.current && inFlightRef.current.token === token) {
        // A lost 202: the accept reached the server even though the
        // response died. Our claim is running - let the poll resolve it.
        const t = viewRef.current?.turn;
        if (
          r.code === "network" &&
          t?.phase === "running" &&
          t.promptId === promptId
        )
          return;
        clearLongTimer();
        inFlightRef.current = null;
        setWorking(false);
        setNoticeAnnounced({
          kind: "error",
          text:
            r.code === "network"
              ? "That did not go through. Your answer is still here; send it again."
              : r.message,
        });
      } else if (r.code === "stale_question") {
        setNoticeAnnounced({
          kind: "info",
          text: "This question was already answered in another tab. Here is where the draft is now.",
        });
      }
      return;
    }

    clearLongTimer();
    inFlightRef.current = null;
    setWorking(false);
    if (restyle) abortRestyleRun();
    if (r.status === 401) {
      setSignedOut(true);
      return;
    }
    if (r.code === "turn_pending") {
      // Another tab's turn is mid-flight; the poll cadence picks it up.
      setNoticeAnnounced({ kind: "info", text: r.message });
      void fetchProject();
      return;
    }
    if (r.code === "brain_unavailable" || r.code === "invalid_turn") {
      resolveTurnFailure(r.code, r.message);
      return;
    }
    setNoticeAnnounced({ kind: "error", text: r.message });
    if (r.code === "answer_cap" || r.code === "feature_disabled")
      void fetchProject();
  }

  /* ------------------------------------------------------------------ *
   * Restyle run (§5.12 format pass): client-driven chaining of async
   * turns, one host-packed batch each. The next batch is re-packed from
   * the FRESH view; any failure aborts the run honestly (what is done is
   * kept; the button finishes the rest on the next press).
   * ------------------------------------------------------------------ */
  function abortRestyleRun() {
    if (!restyleRunRef.current) return;
    restyleRunRef.current = null;
    setRestylePassNote("");
    setAnnounce(
      "Reformatting stopped. What is done so far is kept; press Reformat the whole draft again to finish."
    );
  }

  function startRestyle() {
    const v = viewRef.current;
    if (!v || working || inFlightRef.current || restyleRunRef.current) return;
    const targets = restyleTargets(v.documents, v.placeholderSections ?? {});
    if (!targets.length) {
      setNoticeAnnounced({
        kind: "info",
        text: "Nothing is drafted yet. The format applies as sections are drafted.",
      });
      return;
    }
    const batches = packRestyleBatches(v.documents, targets);
    const baseline = new Map<string, string>();
    for (const d of v.documents)
      for (const s of d.sections)
        baseline.set(`${d.slug}#${s.id}`, textContentKey(s.markdown));
    restyleRunRef.current = {
      pendingRefs: targets.filter((r) => !batches[0].includes(r)),
      changedRefs: new Set(),
      pass: 1,
      totalEstimate: batches.length,
      baseline,
    };
    setRestylePassNote(
      batches.length > 1 ? `Pass 1 of about ${batches.length}.` : ""
    );
    setAnnounce(
      `Applying the format sample to ${targets.length} ${targets.length === 1 ? "section" : "sections"}${
        batches.length > 1 ? ` in about ${batches.length} passes` : ""
      }. Each pass uses one drafting call.`
    );
    void submitTurn({ skipped: false, restyle: true, focusSections: batches[0] });
  }

  /** One restyle pass landed (handleView calls this through the ref). */
  function continueRestyleRun(next: ProjectView) {
    const run = restyleRunRef.current;
    if (!run) return;
    for (const [slug, secs] of Object.entries(next.changedSections))
      for (const sid of secs) run.changedRefs.add(`${slug}#${sid}`);
    // Re-derive what is still safely restylable from the FRESH view: a
    // concurrent tab may have changed, removed, or re-scaffolded sections.
    const stillValid = new Set(
      restyleTargets(next.documents, next.placeholderSections ?? {})
    );
    run.pendingRefs = run.pendingRefs.filter((r) => stillValid.has(r));
    if (!run.pendingRefs.length) {
      finishRestyleRun(next, run);
      return;
    }
    if (next.turn?.phase === "running") {
      // Another tab claimed a turn in the gap: stop honestly.
      abortRestyleRun();
      return;
    }
    const batches = packRestyleBatches(next.documents, run.pendingRefs);
    const batch = batches[0];
    run.pendingRefs = run.pendingRefs.filter((r) => !batch.includes(r));
    run.pass += 1;
    const total = Math.max(run.totalEstimate, run.pass);
    setRestylePassNote(`Pass ${run.pass} of about ${total}.`);
    window.setTimeout(() => {
      if (restyleRunRef.current !== run) return;
      if (inFlightRef.current || viewRef.current?.turn?.phase === "running") {
        abortRestyleRun();
        return;
      }
      void submitTurn({ skipped: false, restyle: true, focusSections: batch });
      // submitTurn's sync prologue sets inFlightRef before its first await;
      // if it bailed instead, abort so the run can't hang holding the ref.
      if (!inFlightRef.current) abortRestyleRun();
    }, 0);
  }

  function finishRestyleRun(next: ProjectView, run: {
    changedRefs: Set<string>;
    baseline: Map<string, string>;
  }) {
    restyleRunRef.current = null;
    setRestylePassNote("");
    const changed = [...run.changedRefs];
    // Union highlight across all passes: each pass replaced the previous
    // pass's Updated chips; the final receipt restores the full set.
    const map: Record<string, string[]> = {};
    const list: ChangedRef[] = [];
    for (const ref of changed) {
      const i = ref.indexOf("#");
      const slug = ref.slice(0, i);
      const sid = ref.slice(i + 1);
      (map[slug] ??= []).push(sid);
      const doc = next.documents.find((d) => d.slug === slug);
      const si = doc?.sections.findIndex((s) => s.id === sid) ?? -1;
      if (doc && si >= 0)
        list.push({
          doc: slug,
          section: sid,
          title: sectionTitleText(si + 1, doc.sections[si].title),
        });
    }
    setHighlights(map);
    setChangedNow(list.length ? list : null);
    setFlashKey((k) => k + 1);
    // Honest receipt: "wording unchanged" is VERIFIED (format-stripped text
    // compare against the pre-run baseline), never asserted.
    let wordingChanged = false;
    for (const ref of changed) {
      const base = run.baseline.get(ref);
      if (base === undefined) continue;
      const i = ref.indexOf("#");
      const md =
        next.documents
          .find((d) => d.slug === ref.slice(0, i))
          ?.sections.find((s) => s.id === ref.slice(i + 1))?.markdown ?? "";
      if (textContentKey(md) !== base) {
        wordingChanged = true;
        break;
      }
    }
    setAnnounce(
      changed.length === 0
        ? "Your draft already matches the sample. Nothing needed to change."
        : wordingChanged
          ? `Reformatted ${changed.length} ${changed.length === 1 ? "section" : "sections"}. I also touched some wording; the changed sections are marked, worth a skim.`
          : `Reformatted. ${changed.length} ${changed.length === 1 ? "section" : "sections"} now match your sample; the wording is unchanged.`
    );
  }

  useEffect(() => {
    continueRestyleRef.current = continueRestyleRun;
  });

  /** Keep one open [TO CONFIRM] item as drafted: deterministic server-side
   *  strip, zero AI calls (works through brain outages). The view is merged
   *  in place so the row disappears and the section flashes Updated in the
   *  same render; the resolver handles its own focus continuity. */
  async function keepItem(item: OpenConfirmItem): Promise<KeepResult> {
    const v = viewRef.current;
    if (!v || working) return { ok: false };
    const r = await api<TurnResponse>(
      `/api/governance/projects/${encodeURIComponent(projectId)}/resolve-item`,
      {
        method: "POST",
        body: JSON.stringify({
          doc: item.doc,
          section: item.section,
          excerpt: item.excerpt,
          occurrence: item.occurrence,
        }),
      }
    );
    if (r.ok) {
      const nowIso = new Date().toISOString();
      const next: ProjectView = {
        ...v,
        rev: r.data.rev,
        documents: r.data.documents,
        changedSections: r.data.changedSections,
        placeholderSections:
          r.data.placeholderSections ?? v.placeholderSections,
        openConfirmItems: r.data.openConfirmItems,
        openConfirmTotal:
          r.data.openConfirmTotal ?? r.data.openConfirmItems.length,
        reviewSummary: r.data.reviewSummary,
        transcript: [
          ...v.transcript,
          {
            qId: "confirm",
            bankId: null,
            q: `Open item: ${item.excerpt.slice(0, 160)}`,
            a: "Kept as drafted.",
            skipped: false,
            askedAt: nowIso,
            answeredAt: nowIso,
          },
        ],
      };
      viewRef.current = next;
      setView(next);
      setHighlights(r.data.changedSections);
      setFlashKey((k) => k + 1);
      const left = next.openConfirmTotal;
      setAnnounce(
        left === 0
          ? "Kept as drafted. Every open item is resolved; you can confirm the final draft."
          : `Kept as drafted. ${left} open ${left === 1 ? "item" : "items"} left.`
      );
      return { ok: true };
    }
    if (r.status === 401) {
      setSignedOut(true);
      return { ok: false };
    }
    if (r.code === "item_not_found") {
      // Already resolved (another tab) or the rev moved: re-sync the list.
      void fetchProject();
      return {
        ok: false,
        message:
          "That item was already resolved, maybe in another tab. The list is refreshed.",
      };
    }
    return { ok: false, message: r.message };
  }

  async function startResearch(mode: "full" | "partial") {
    if (researchBusy) return;
    setResearchBusy(true);
    setResearchError("");
    const r = await api<{ status: string }>(
      `/api/governance/projects/${encodeURIComponent(projectId)}/research`,
      {
        method: "POST",
        body: JSON.stringify(mode === "partial" ? { mode: "partial" } : {}),
      }
    );
    setResearchBusy(false);
    if (!r.ok) {
      if (r.status === 401) {
        setSignedOut(true);
        return;
      }
      setResearchError(r.message);
    }
    void fetchProject();
  }

  async function confirmFinal() {
    const v = viewRef.current;
    if (!v || confirmBusy) return;
    // Client-side intercept of the server's confirm gate: the button stays
    // enabled (a dead button with no reason is worse) and this explains.
    const undrafted = Object.values(v.placeholderSections ?? {}).reduce(
      (n, secs) => n + secs.length,
      0
    );
    if (undrafted > 0) {
      setNoticeAnnounced({
        kind: "info",
        text: `Almost. ${undrafted} ${undrafted === 1 ? "section is" : "sections are"} not drafted yet. Use the list above to jump to each one and ask Tron to draft it, then confirm.`,
      });
      return;
    }
    const openTotal = v.openConfirmTotal ?? v.openConfirmItems.length;
    if (openTotal > 0) {
      setNoticeAnnounced({
        kind: "info",
        text: `Almost. ${openTotal} open ${openTotal === 1 ? "item" : "items"} above still ${openTotal === 1 ? "needs" : "need"} your answer. Type the correct fact or keep it as drafted, item by item, then confirm.`,
      });
      return;
    }
    setConfirmBusy(true);
    const r = await api<{ status: string }>(
      `/api/governance/projects/${encodeURIComponent(projectId)}/confirm`,
      { method: "POST", body: "{}" }
    );
    setConfirmBusy(false);
    if (r.ok) {
      const next: ProjectView = { ...v, status: "done" };
      viewRef.current = next;
      setView(next);
      setHighlights({});
      setChangedNow(null);
      setAnnounce("Final draft saved. Ready to download.");
    } else if (r.status === 401) {
      setSignedOut(true);
    } else {
      setNoticeAnnounced({ kind: "error", text: r.message });
    }
  }

  if (gone) return <GonePanel />;

  if (!view) {
    return (
      <div className="mx-auto max-w-xl pt-12 text-center">
        <LiveRegion text={announce} />
        <span className="sys-label sys-label--center">AI Governance</span>
        {signedOut ? (
          <div className="panel panel--raised mt-8">
            <p className="text-sm">
              You got signed out. Sign back in; your work is saved right where
              you left it.
            </p>
            <a
              href={`/login?redirect=${encodeURIComponent(`/governance/${projectId}`)}`}
              className="btn btn--primary mt-4 no-underline"
            >
              Sign in
            </a>
          </div>
        ) : (
          <p className="mt-8 text-sm" style={dim}>
            {pollFails > 0
              ? "Could not load this project. Retrying..."
              : "Loading your project..."}
          </p>
        )}
      </div>
    );
  }

  const meta = STATUS_META[view.status];
  const kindName = KIND_LABELS[view.kind].name;
  const showSplit =
    view.status === "drafting" ||
    view.status === "review" ||
    view.status === "done";

  const download = (
    <DownloadMenu
      projectId={view.id}
      documents={view.documents}
      status={view.status}
      deletesAt={view.deletesAt}
    />
  );

  return (
    <div>
      <LiveRegion text={announce} />

      {signedOut && (
        <div className="panel panel--raised mb-6 flex flex-wrap items-center gap-4">
          <p className="max-w-none text-sm">
            You got signed out. Sign back in; your work is saved right where
            you left it.
          </p>
          <a
            href={`/login?redirect=${encodeURIComponent(`/governance/${projectId}`)}`}
            className="btn btn--primary ml-auto no-underline"
          >
            Sign in
          </a>
        </div>
      )}

      {view.featureDisabled && (
        <div className="panel mb-6">
          <p className="max-w-none text-sm">
            New drafting is paused. Your project and downloads still work, and
            the auto-delete date is unchanged.
          </p>
        </div>
      )}

      {pollFails >= 3 && (
        <div className="panel mb-6">
          <p className="max-w-none text-sm" style={{ color: "var(--xl-warn)" }}>
            Connection lost. The page will keep trying; nothing you typed is
            lost.
          </p>
        </div>
      )}

      <div className="workbar mb-8">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
          <Link href="/governance" className="btn btn--text no-underline">
            Projects
          </Link>
          <h1 className="min-w-0 text-lg" style={{ letterSpacing: "0.1em" }}>
            {kindName} · {view.domain}
          </h1>
          <div className="ml-auto flex flex-wrap items-center gap-4">
            <StatusBadge status={view.status} />
            <span className="hidden text-xs sm:inline" style={dim}>
              {meta.note}
            </span>
            {download}
          </div>
        </div>
        <div className="mono pb-2 text-xs" style={faint}>
          Auto-deletes {fmtDate(view.deletesAt)}
        </div>
      </div>

      {!showSplit ? (
        <ResearchScreen
          view={view}
          resuming={resuming}
          busy={researchBusy}
          actionError={researchError}
          onStartResearch={() => void startResearch("full")}
          onPartialStart={() => void startResearch("partial")}
          onAnnounce={setAnnounce}
        />
      ) : (
        <>
          {/* Mobile: segmented Questions | Draft (spec 8.6). */}
          <div
            className="tabstrip mb-6 lg:hidden"
            role={!isDesktop ? "tablist" : undefined}
            aria-label="Workspace panes"
          >
            <button
              type="button"
              id="gov-tab-questions"
              role={!isDesktop ? "tab" : undefined}
              aria-selected={!isDesktop ? mobileTab === "questions" : undefined}
              aria-controls={!isDesktop ? "gov-pane-questions" : undefined}
              tabIndex={!isDesktop && mobileTab !== "questions" ? -1 : undefined}
              onClick={() => setMobileTab("questions")}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  setMobileTab("draft");
                  document.getElementById("gov-tab-draft")?.focus();
                }
              }}
            >
              Questions
            </button>
            <button
              type="button"
              id="gov-tab-draft"
              role={!isDesktop ? "tab" : undefined}
              aria-selected={!isDesktop ? mobileTab === "draft" : undefined}
              aria-controls={!isDesktop ? "gov-pane-draft" : undefined}
              tabIndex={!isDesktop && mobileTab !== "draft" ? -1 : undefined}
              aria-label={
                draftDot > 0 && askPending
                  ? `Draft, ${draftDot} sections updated, includes the text this question is about`
                  : draftDot > 0
                    ? `Draft, ${draftDot} sections updated`
                    : askPending
                      ? "Draft, shows the text this question is about"
                      : undefined
              }
              onClick={() => {
                setMobileTab("draft");
                // A queued resolution reveal plays now (it owns the scroll);
                // otherwise the asked-about anchor wins over the changed-
                // section jump: the user's next task is reading that text.
                const pendingShow = pendingShowRef.current;
                if (pendingShow && pendingShow.rev === view.rev) {
                  pendingShowRef.current = null;
                  setDraftDot(0);
                  setAskPending(false);
                  window.setTimeout(
                    () =>
                      startShow(
                        pendingShow.items,
                        pendingShow.askRef,
                        pendingShow.rev
                      ),
                    60
                  );
                  return;
                }
                pendingShowRef.current = null;
                const ask =
                  askPending &&
                  view.status === "drafting" &&
                  view.nextQuestion
                    ? firstFeedTarget(view.nextQuestion.feeds, view.documents)
                    : null;
                const first = changedNow?.[0];
                if (ask) jumpTo(ask.doc, ask.section, false);
                else if (draftDot > 0 && first)
                  jumpTo(first.doc, first.section, false);
                setDraftDot(0);
                setAskPending(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  setMobileTab("questions");
                  document.getElementById("gov-tab-questions")?.focus();
                }
              }}
            >
              Draft
              {(draftDot > 0 || askPending) && (
                <span
                  className="dot"
                  style={{ color: "var(--xl-light)" }}
                  aria-hidden="true"
                />
              )}
              {draftDot > 0 && <span aria-hidden="true">· {draftDot}</span>}
            </button>
          </div>

          <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-8">
            <div
              id="gov-pane-questions"
              role={!isDesktop ? "tabpanel" : undefined}
              aria-labelledby={!isDesktop ? "gov-tab-questions" : undefined}
              className={`min-w-0 ${mobileTab === "questions" ? "block" : "hidden"} lg:block`}
            >
              <QuestionPane
                view={view}
                projectId={view.id}
                answerText={answerText}
                onAnswerChange={setAnswerText}
                onToggleSuggestion={toggleSuggestion}
                working={working}
                workingKind={workingKind}
                workingLong={workingLong}
                brainDown={brainDown}
                chaseBridge={chaseBridge}
                featureDisabled={view.featureDisabled}
                notice={notice}
                skipPending={skipPending}
                onSkipRequest={() => setSkipPending(true)}
                onSkipCancel={() => setSkipPending(false)}
                onSkipConfirm={() => void submitTurn({ skipped: true })}
                onSend={() => void submitTurn({ skipped: false })}
                onRevise={() => void submitTurn({ skipped: false })}
                onAmend={(index, amendAnswer) =>
                  void submitTurn({ skipped: false, amendIndex: index, amendAnswer })
                }
                onConfirm={() => void confirmFinal()}
                confirmBusy={confirmBusy}
                onJump={jumpTo}
                onKeepItem={keepItem}
                onSendResolved={(message, focusSections) =>
                  void submitTurn({ skipped: false, message, focusSections })
                }
                onAnnounce={setAnnounce}
                questionHeadingRef={questionHeadingRef}
                reviewHeadingRef={reviewHeadingRef}
                downloadSlot={download}
              />

              {/* Owner rule (round 3): the format sample lives in the
                  QUESTIONS column, right under the conversation, so it is
                  visible while answering (desktop left pane + the mobile
                  Questions tab) instead of buried below the document. */}
              <StyleSampleControl
                projectId={view.id}
                initialName={view.styleSample?.name ?? null}
                disabled={view.featureDisabled}
                removeOnly={view.status === "done"}
                note="A new or changed sample shapes the sections Tron edits from now on. Use Reformat the whole draft below to restyle what is already drafted."
                reformat={{
                  available:
                    (view.status === "drafting" || view.status === "review") &&
                    restyleTargets(
                      view.documents,
                      view.placeholderSections ?? {}
                    ).length > 0,
                  busy: working && workingKind === "restyle",
                  long: workingLong,
                  locked: working || view.featureDisabled || brainDown,
                  passNote: restylePassNote,
                  onStart: startRestyle,
                }}
                onAnnounce={setAnnounce}
                onChanged={() => void fetchProject()}
              />
            </div>
            <div
              id="gov-pane-draft"
              role={!isDesktop ? "tabpanel" : undefined}
              aria-labelledby={!isDesktop ? "gov-tab-draft" : undefined}
              className={`mt-8 min-w-0 lg:mt-0 ${mobileTab === "draft" ? "block" : "hidden"} lg:block`}
              // Manual reading intent in the doc pane cancels any pending
              // ask-anchor scroll AND ends the reveal show (wheel, touch,
              // or scroll keys): the user's own movement always wins.
              onWheel={() => {
                cancelAskJump();
                endShow(false);
              }}
              onTouchMove={() => {
                cancelAskJump();
                endShow(false);
              }}
              onKeyDown={(e) => {
                if (SCROLL_KEYS.has(e.key)) {
                  cancelAskJump();
                  endShow(false);
                }
              }}
            >
              <DocPane
                documents={view.documents}
                activeDoc={activeDoc}
                onSelectDoc={setActiveDoc}
                highlights={highlights}
                asking={asking}
                placeholders={view.placeholderSections ?? {}}
                flashKey={flashKey}
                changedNow={changedNow}
                onJump={jumpTo}
                status={view.status}
                deletesAt={view.deletesAt}
                resolvedMarks={resolvedMarks}
                reveal={reveal}
                showStatus={
                  showStatus
                    ? { ...showStatus, onSkip: () => endShow(false) }
                    : null
                }
                showNote={showNote}
              />

            </div>
          </div>
        </>
      )}
    </div>
  );
}
