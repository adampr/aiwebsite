// The Lightline Runway (§5.18): one luminous hairline through five diamond
// nodes, horizontal on wide screens, a vertical left rail below. Server
// component; state comes entirely from the ONE server-computed RoadmapStatus
// so the runway can never disagree with the step panels. status === null
// renders the public teaser's zero state (all nodes dim, node 01 shimmering).
//
// Round 3 (action center): signed-in stops are REAL LINKS to their steps.
// Segments and stops stay DIRECT flex children of .rmp-runway (the lg flex
// math depends on it - no nav>ol wrapper). The links' visible text (num +
// title + state word) is its own narration, so the signed-in branch has no
// sr-only <ol>; only attention/init get a tiny sr-only expansion. The teaser
// branch keeps the aria-hidden ornament plus one sr-only sentence, and its
// stops are NOT links.
//
// Step 05 (dkim) is a VERDICT step, not a task step: it never takes the
// pulse. The frontier ("Up next") is computed over the first four steps
// only, and dkim gets its own states: done (verdict ok), attention (verdict
// missing), unconfirmed (verdict unknown), init (the 800ms status race
// timed out; a detached check is still running). RUNWAY INIT IS DKIM-ONLY:
// the directory node never shows Initializing (the server cannot know an
// import is running). The 04-to-05 segment lights when the scorecard is
// live AND the dkim verdict is ok.
//
// All motion is CSS-only and fully disabled under prefers-reduced-motion
// (roadmap.css).

import { Fragment } from "react";
import Link from "next/link";
import { ROADMAP_STEPS, type RoadmapStepKey } from "@/lib/roadmap/config";
import type { RoadmapStatus } from "@/lib/roadmap/status";

type NodeState =
  | "dim"
  | "upnext"
  | "done"
  | "live"
  | "attention"
  | "unconfirmed"
  | "init";

const faint = { color: "var(--xl-text-faint)" } as const;

function badgeText(s: NodeState): string {
  if (s === "done") return "Done";
  if (s === "live") return "Live";
  if (s === "upnext") return "Up next"; // NEVER "In progress" (owner ruling)
  if (s === "attention") return "Attention";
  if (s === "unconfirmed") return "Unconfirmed";
  if (s === "init") return "Initializing..."; // dots are literal characters
  return "Not started";
}

/** Task steps 01-04 in order: the only steps the Up-next pulse considers. */
const PULSE_KEYS = ["governance", "directory", "work", "scorecard"] as const;

export function RoadmapRunway({ status }: { status: RoadmapStatus | null }) {
  // "reached" drives segment lighting: done for the task steps, live for the
  // scorecard (never "done": it is ongoing), verdict ok for dkim.
  const reached: Record<RoadmapStepKey, boolean> = status
    ? {
        governance: status.governance.done,
        directory: status.directory.done,
        work: status.work.done,
        scorecard: status.scorecard.live,
        dkim: status.dkim.verdict === "ok",
      }
    : { governance: false, directory: false, work: false, scorecard: false, dkim: false };

  const frontierKey = status
    ? (PULSE_KEYS.find((k) => !reached[k]) ?? null)
    : null;

  function stateFor(key: RoadmapStepKey): NodeState {
    if (!status) return "dim"; // teaser: plain dim everywhere (01 shimmers)
    if (key === "dkim") {
      if (status.dkim.timedOut === true) return "init";
      if (status.dkim.verdict === "ok") return "done";
      if (status.dkim.verdict === "missing") return "attention";
      return "unconfirmed";
    }
    if (reached[key]) return key === "scorecard" ? "live" : "done";
    if (key === frontierKey) return "upnext";
    return "dim";
  }

  const states = ROADMAP_STEPS.map((step) => stateFor(step.key));

  // containerHidden: the teaser wraps everything in one aria-hidden
  // container, so its segments need no individual attribute; the signed-in
  // branch has NO container-level aria-hidden, so each seg carries its own.
  function segFor(i: number, containerHidden: boolean) {
    const lit =
      reached[ROADMAP_STEPS[i - 1].key] && reached[ROADMAP_STEPS[i].key];
    return (
      <span
        aria-hidden={containerHidden ? undefined : true}
        className={"rmp-seg" + (lit ? " rmp-seg--lit" : "")}
        // Load animation staggers left to right; only lit segments animate,
        // so the delay index is per segment position.
        style={lit ? { animationDelay: `${(i - 1) * 150}ms` } : undefined}
      />
    );
  }

  function stopBody(i: number) {
    const step = ROADMAP_STEPS[i];
    return (
      <span className="rmp-stop-text">
        <span className="rmp-stop-num">{step.num}</span>
        <span className="rmp-stop-title">{step.title}</span>
        <span className={`rmp-state rmp-state--${states[i]}`}>
          {badgeText(states[i])}
          {states[i] === "attention" && (
            <span className="sr-only"> Needs attention</span>
          )}
          {states[i] === "init" && (
            <span className="sr-only"> Checking now</span>
          )}
        </span>
      </span>
    );
  }

  if (status === null) {
    // Teaser: pure ornament (aria-hidden) plus one sr-only sentence.
    return (
      <div>
        <div className="rmp-runway" aria-hidden="true">
          {ROADMAP_STEPS.map((step, i) => (
            <Fragment key={step.key}>
              {i > 0 && segFor(i, true)}
              <div className="rmp-stop">
                <span className="rmp-node-cell">
                  <span
                    className={"rmp-node" + (i === 0 ? " rmp-node--shimmer" : "")}
                  />
                </span>
                {stopBody(i)}
              </div>
            </Fragment>
          ))}
        </div>
        <p className="sr-only">Five steps, none started yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="rmp-runway">
        {ROADMAP_STEPS.map((step, i) => {
          const nodeCls =
            "rmp-node" +
            (states[i] === "dim" ? "" : ` rmp-node--${states[i]}`);
          return (
            <Fragment key={step.key}>
              {i > 0 && segFor(i, false)}
              <Link href={step.href} className="rmp-stop">
                <span className="rmp-node-cell" aria-hidden="true">
                  <span className={nodeCls} />
                </span>
                {stopBody(i)}
              </Link>
            </Fragment>
          );
        })}
      </div>
      <p className="mono mt-6 text-center text-xs" style={faint}>
        Every step is open at any time. Start wherever helps most.
      </p>
    </div>
  );
}
