"use client";

// Pre-drafting workspace screens: created / queued / researching /
// research_failed. The queued state is honest about the fact that nothing is
// working yet (critique B1) and never shows the duration estimate (N1).

import type { ProjectView, ResearchStep } from "@/lib/governance/types";
import { RESEARCH_DURATION_COPY } from "@/lib/governance/config";
import { StyleSampleControl } from "./style-sample-control";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

const STEP_ORDER: ResearchStep[] = [
  "site",
  "mentions",
  "industry",
  "distill",
  "handoff",
];

export function stepIndex(step: ResearchStep): number {
  const i = STEP_ORDER.indexOf(step);
  return i < 0 ? 0 : i;
}

/** Live-region label for a research step transition (N3: steps only). */
export function researchStepLabel(step: ResearchStep, domain: string): string {
  if (step === "site") return `reading ${domain}`;
  if (step === "mentions") return "searching the web for mentions of you";
  if (step === "industry") return "studying your industry";
  if (step === "distill") return "writing the working brief";
  // handoff: the turn-zero group calls can hold this step for a few minutes
  // on the document sets; the label must say what is actually happening.
  return "drafting your starting documents";
}

function Glyph({ state }: { state: "pending" | "active" | "done" }) {
  if (state === "done")
    return (
      <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
        <path
          d="M3 8.5 6.5 12 13 4.5"
          fill="none"
          stroke="var(--xl-ok)"
          strokeWidth="1.5"
        />
      </svg>
    );
  if (state === "active")
    return (
      <span
        className="dot shrink-0"
        style={{ color: "var(--xl-light)" }}
        aria-hidden="true"
      />
    );
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="4"
        fill="none"
        stroke="var(--xl-line-bright)"
        strokeWidth="1"
      />
    </svg>
  );
}

function Radar() {
  return (
    <div className="radar mx-auto shrink-0" aria-hidden="true">
      <i className="radar-blip" style={{ left: "62%", top: "34%" }} />
      <i className="radar-blip radar-blip--sand" style={{ left: "30%", top: "58%" }} />
    </div>
  );
}

export function ResearchScreen({
  view,
  resuming,
  busy,
  actionError,
  onStartResearch,
  onPartialStart,
  onAnnounce,
}: {
  view: ProjectView;
  resuming: boolean;
  busy: boolean;
  actionError: string;
  onStartResearch: () => void;
  onPartialStart: () => void;
  onAnnounce: (text: string) => void;
}) {
  const { status, domain } = view;

  // Add/replace the format sample while research runs: the first draft pass
  // already writes in the user's format when the sample is here in time.
  const sample = (
    <StyleSampleControl
      projectId={view.id}
      initialName={view.styleSample?.name ?? null}
      disabled={view.featureDisabled}
      onAnnounce={onAnnounce}
    />
  );

  if (status === "created") {
    return (
      <div className="panel mx-auto mt-8 max-w-2xl text-center">
        <span className="sys-label sys-label--center">AI Governance</span>
        <p className="mx-auto mt-4 text-sm" style={dim}>
          Setting up your project. Research starts in a moment; this page
          updates on its own.
        </p>
        {sample}
      </div>
    );
  }

  if (status === "queued") {
    return (
      <div className="panel mx-auto mt-8 max-w-2xl">
        <span className="badge badge--warn">Queued</span>
        <h2 className="mt-6">Waiting in line</h2>
        <p className="mt-4 text-sm">
          Research is waiting its turn: today&apos;s research budget is used
          up (it resets at midnight UTC), or a brief site update is in
          progress. Your project is saved; you can leave and come back, this
          page updates on its own, and the Start button below retries now.
        </p>
        {resuming && (
          <p className="mt-3 text-sm" style={dim}>
            Resuming research...
          </p>
        )}
        {actionError && (
          <p className="mt-3 text-sm" style={{ color: "var(--xl-warn)" }}>
            {actionError}
          </p>
        )}
        <button
          type="button"
          className="btn mt-6"
          disabled={busy}
          onClick={onStartResearch}
        >
          {busy ? "Starting..." : "Start research"}
        </button>
        {sample}
      </div>
    );
  }

  if (status === "research_failed") {
    return (
      <div className="panel mx-auto mt-8 max-w-2xl">
        <div className="flex flex-wrap items-center gap-4">
          <span className="badge badge--danger">Paused</span>
          <span className="text-sm" style={dim}>
            Research paused.
          </span>
        </div>
        <p className="mt-4 text-sm">
          I could not finish researching {domain}. Your project is saved and
          nothing is lost.
        </p>
        {actionError && (
          <p className="mt-3 text-sm" style={{ color: "var(--xl-warn)" }}>
            {actionError}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-6">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onStartResearch}
          >
            Retry research
          </button>
          <button
            type="button"
            className="btn btn--text"
            disabled={busy}
            onClick={onPartialStart}
          >
            Start the questions anyway
          </button>
        </div>
        <p className="mt-3 text-xs" style={faint}>
          I will work from what I found so far and say so in the draft.
        </p>
        {sample}
      </div>
    );
  }

  // researching
  const rp = view.researchProgress;
  const currentIdx = rp ? stepIndex(rp.step) : 0;
  const counts = rp?.counts ?? {};
  const rows: {
    label: string;
    detail: string;
    first: number;
    last: number;
  }[] = [
    {
      label: `Reading ${domain}`,
      detail: counts.pages !== undefined ? `${counts.pages} pages` : "",
      first: 0,
      last: 0,
    },
    {
      label: "Searching the web for mentions of you",
      detail:
        counts.mentions !== undefined ? `${counts.mentions} results read` : "",
      first: 1,
      last: 1,
    },
    {
      label: "Studying your industry",
      detail:
        counts.industry !== undefined ? `${counts.industry} sources` : "",
      first: 2,
      last: 2,
    },
    { label: "Writing the working brief", detail: "distilling", first: 3, last: 4 },
  ];

  return (
    <div className="panel panel--lightline mx-auto mt-8 max-w-3xl">
      <div className="flex flex-col items-start gap-8 sm:flex-row">
        <Radar />
        <div className="min-w-0 flex-1">
          <span className="sys-label">Tron is researching</span>
          <h2 className="mt-4">Learning your company first</h2>
          <p className="mt-4 text-sm">
            I read before I ask. This usually takes {RESEARCH_DURATION_COPY}.
            You can leave; I keep working, this page updates on its own, and
            your project is saved.
          </p>
          <ul className="mt-6 space-y-3">
            {rows.map((row) => {
              const state: "pending" | "active" | "done" =
                currentIdx > row.last
                  ? "done"
                  : currentIdx >= row.first
                    ? "active"
                    : "pending";
              return (
                <li
                  key={row.label}
                  className="flex items-center gap-3"
                  aria-current={state === "active" ? "step" : undefined}
                >
                  <Glyph state={state} />
                  <span
                    className="text-sm"
                    style={state === "pending" ? faint : undefined}
                  >
                    {row.label}
                  </span>
                  {state !== "pending" && row.detail && (
                    <span className="mono ml-auto text-xs" style={faint}>
                      {row.detail}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <hr className="rule" style={{ margin: "var(--sp-6) 0" }} />
          <p className="text-sm" style={dim}>
            Next: I will ask you a short series of questions and draft the
            document live as you answer.
          </p>
          {sample}
        </div>
      </div>
    </div>
  );
}
