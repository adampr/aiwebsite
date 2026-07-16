"use client";

// /governance/[id] workspace core (§5.12 UI). Owns the poll loop, the
// drafting/review state machine, the answer round-trip (promptId lifecycle,
// stale-tab and dropped-connection recovery), the update choreography, the
// single polite live region, and the desktop split / mobile two-tab layout.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { KIND_LABELS } from "@/lib/governance/config";
import type {
  GovernanceDoc,
  ProjectStatus,
  ProjectView,
  TranscriptEntry,
} from "@/lib/governance/types";
import {
  api,
  firstFeedTarget,
  fmtDate,
  mintPromptId,
  parseFeedRef,
  StatusBadge,
  STATUS_META,
  toggleChipInAnswer,
  type FeedRef,
  type TurnResponse,
} from "./shared";
import { ResearchScreen, researchStepLabel } from "./research-screen";
import { DocPane, secDomId, type ChangedRef } from "./doc-pane";
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
  } | null>(null);
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
   *  section wins the final scroll position (scheduleAskJump). */
  const applyChangedChoreography = useCallback(
    (
      changed: Record<string, string[]>,
      docs: GovernanceDoc[],
      newStatus: ProjectStatus,
      prevStatus: ProjectStatus,
      askRef: FeedRef | null
    ) => {
      const list: ChangedRef[] = [];
      for (const [dslug, secs] of Object.entries(changed)) {
        const doc = docs.find((d) => d.slug === dslug);
        for (const sid of secs) {
          const s = doc?.sections.find((x) => x.id === sid);
          list.push({ doc: dslug, section: sid, title: s?.title ?? sid });
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
        if (list.length) {
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
        if (asking) {
          const reduce = window.matchMedia(
            "(prefers-reduced-motion: reduce)"
          ).matches;
          scheduleAskJump(asking, list.length && !reduce ? 1600 : 60);
        }
      }
      const titles = list.map((x) => x.title).join(", ");
      if (newStatus === "review" && prevStatus !== "review") {
        setAnnounce(
          "Tron is done asking questions. The full draft is ready for your review."
        );
        focusSoon(reviewHeadingRef);
      } else if (newStatus === "review") {
        setAnnounce(list.length ? `Draft updated: ${titles}.` : "Draft unchanged.");
      } else {
        setAnnounce(
          list.length
            ? `Draft updated: ${titles}. Next question is ready.`
            : "Next question is ready."
        );
        focusSoon(questionHeadingRef);
      }
    },
    [performJump, scheduleAskJump]
  );

  const handleView = useCallback(
    (next: ProjectView) => {
      const prev = viewRef.current;
      viewRef.current = next;
      setView(next);
      setPollFails(0);
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

      // An in-flight turn that landed while the response was lost (S7): the
      // poll sees the advanced rev and renders the turn as success.
      const flight = inFlightRef.current;
      let choreographed = false;
      if (prev && flight && next.rev > flight.preSendRev) {
        inFlightRef.current = null;
        pendingRef.current = null;
        clearDraft(flight.questionId);
        setWorking(false);
        setBrainDown(false);
        applyChangedChoreography(
          next.changedSections,
          next.documents,
          next.status,
          prev.status,
          next.nextQuestion
            ? firstFeedTarget(next.nextQuestion.feeds, next.documents)
            : null
        );
        choreographed = true;
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
          // it is about (owner fix #3), without touching focus.
          const askRef = next.nextQuestion
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
            "Tron is done asking questions. The full draft is ready for your review."
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
    [applyChangedChoreography, clearDraft, scheduleAskJump]
  );

  const fetchProject = useCallback(async (): Promise<ProjectView | null> => {
    const r = await api<ProjectView>(
      `/api/governance/projects/${encodeURIComponent(projectId)}`
    );
    if (r.ok) {
      handleView(r.data);
      setSignedOut(false);
      // S3: a successful GET after a brain outage re-enables Send.
      setBrainDown(false);
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
  // runs only while a send is in flight (10 s) or during a brain-down
  // recheck (15 s); plus a retry cadence after transient poll failures.
  const loaded = view !== null;
  const status = view?.status ?? null;
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
    else if (working) ms = 10_000;
    else if (brainDown) ms = 15_000;
    else if (pollFails > 0) ms = 8000;
    if (ms === null) return;
    const t = window.setInterval(() => void fetchProject(), ms);
    return () => window.clearInterval(t);
  }, [loaded, status, working, brainDown, pollFails, gone, signedOut, fetchProject]);

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
  // project leaves drafting.
  const asking = useMemo(() => {
    const map: Record<string, string[]> = {};
    if (view && view.status === "drafting" && view.nextQuestion) {
      for (const f of view.nextQuestion.feeds) {
        const ref = parseFeedRef(f);
        if (!ref) continue;
        if (!map[ref.doc]) map[ref.doc] = [];
        map[ref.doc].push(ref.section);
      }
    }
    return map;
  }, [view]);

  function applyTurn(
    data: TurnResponse,
    questionId: string,
    skipped: boolean,
    answer: string
  ) {
    const prev = viewRef.current;
    if (!prev) return;
    const nowIso = new Date().toISOString();
    const entry: TranscriptEntry = {
      qId: questionId,
      bankId: questionId === "revise" ? null : (prev.nextQuestion?.bankId ?? null),
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
      progress: data.progress,
      openConfirmItems: data.openConfirmItems,
      transcript: [...prev.transcript, entry],
      answersCount: prev.answersCount + (questionId === "revise" ? 0 : 1),
    };
    viewRef.current = next;
    setView(next);
    setWorking(false);
    applyChangedChoreography(
      data.changedSections,
      data.documents,
      data.status,
      prev.status,
      data.nextQuestion
        ? firstFeedTarget(data.nextQuestion.feeds, data.documents)
        : null
    );
  }

  async function submitTurn(opts: { skipped: boolean }) {
    const v = viewRef.current;
    if (!v || working) return;
    const revise = v.status === "review";
    const questionId = revise ? "revise" : v.nextQuestion?.id;
    if (!questionId) return;
    const answer = opts.skipped ? "" : answerText.trim();
    if (!opts.skipped && !answer) return;

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

    // A new turn supersedes any still-pending ask-anchor scroll.
    cancelAskJump();

    const token = Date.now() + Math.random();
    inFlightRef.current = { preSendRev: v.rev, token, questionId };
    const kind: WorkingKind = revise
      ? "revise"
      : opts.skipped
        ? "skip"
        : "send";
    setWorking(true);
    setWorkingKind(kind);
    setWorkingLong(false);
    setNotice(null);
    setSkipPending(false);
    // The click's instant receipt: the button just disabled under the
    // user's focus, so the live region confirms the send took.
    setAnnounce(
      kind === "skip"
        ? "Question skipped. Tron is drafting a default."
        : kind === "revise"
          ? "Revision sent."
          : "Answer sent."
    );
    const longTimer = window.setTimeout(() => {
      setWorkingLong(true);
      setAnnounce("Still working on the draft.");
    }, 20_000);

    const r = await api<TurnResponse>(
      `/api/governance/projects/${encodeURIComponent(projectId)}/answer`,
      {
        method: "POST",
        body: JSON.stringify({
          questionId,
          answer,
          skipped: opts.skipped || undefined,
          promptId,
        }),
      }
    );
    window.clearTimeout(longTimer);

    const flight = inFlightRef.current;
    if (!flight || flight.token !== token) return; // a poll already resolved it

    if (r.ok) {
      inFlightRef.current = null;
      pendingRef.current = null;
      clearDraft(questionId);
      applyTurn(r.data, questionId, opts.skipped, answer);
      return;
    }

    if (r.code === "stale_question" || r.code === "network") {
      // First refetch; if rev advanced past the pre-send rev, the turn (or
      // another tab's turn) landed and handleView already rendered it.
      await fetchProject();
      if (inFlightRef.current && inFlightRef.current.token === token) {
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

    inFlightRef.current = null;
    setWorking(false);
    if (r.status === 401) {
      setSignedOut(true);
      return;
    }
    if (r.code === "brain_unavailable") {
      // S3: keep the typed answer; polling re-enables Send.
      setBrainDown(true);
      setAnnounce(
        "Tron's drafting engine is offline right now. Your answer is kept here; Send re-enables when he is back."
      );
      return;
    }
    if (r.code === "invalid_turn") {
      pendingRef.current = null; // mint a NEW promptId on the next attempt
      setNoticeAnnounced({ kind: "error", text: r.message });
      return;
    }
    setNoticeAnnounced({ kind: "error", text: r.message });
    if (r.code === "answer_cap" || r.code === "feature_disabled")
      void fetchProject();
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
                // The asked-about anchor wins over the changed-section jump:
                // the user's next task is reading the text in question.
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
                answerText={answerText}
                onAnswerChange={setAnswerText}
                onToggleSuggestion={toggleSuggestion}
                working={working}
                workingKind={workingKind}
                workingLong={workingLong}
                brainDown={brainDown}
                featureDisabled={view.featureDisabled}
                notice={notice}
                skipPending={skipPending}
                onSkipRequest={() => setSkipPending(true)}
                onSkipCancel={() => setSkipPending(false)}
                onSkipConfirm={() => void submitTurn({ skipped: true })}
                onSend={() => void submitTurn({ skipped: false })}
                onRevise={() => void submitTurn({ skipped: false })}
                onConfirm={() => void confirmFinal()}
                confirmBusy={confirmBusy}
                onJump={jumpTo}
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
                note="A new or changed sample shapes the sections Tron edits from now on; already drafted sections keep their look until he next edits them."
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
              // ask-anchor scroll (wheel, touch, or scroll keys).
              onWheel={cancelAskJump}
              onTouchMove={cancelAskJump}
              onKeyDown={(e) => {
                if (SCROLL_KEYS.has(e.key)) cancelAskJump();
              }}
            >
              <DocPane
                documents={view.documents}
                activeDoc={activeDoc}
                onSelectDoc={setActiveDoc}
                highlights={highlights}
                asking={asking}
                flashKey={flashKey}
                changedNow={changedNow}
                onJump={jumpTo}
                status={view.status}
                deletesAt={view.deletesAt}
              />

            </div>
          </div>
        </>
      )}
    </div>
  );
}
