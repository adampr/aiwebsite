// The Lightline Runway (§5.18): one luminous hairline through five diamond
// nodes, horizontal on wide screens, a vertical left rail below. Server
// component; state comes entirely from the ONE server-computed RoadmapStatus
// so the runway can never disagree with the stat strip or step panels.
// status === null renders the public teaser's zero state (all nodes dim,
// node 01 shimmering).
//
// Step 05 (dkim) is a VERDICT step, not a task step: it never takes the
// pulse. The frontier is computed over the first four steps only, and dkim
// gets its own states: done (verdict ok), attention (verdict missing),
// unconfirmed (verdict unknown). The 04-to-05 segment lights when the
// scorecard is live AND the dkim verdict is ok.
//
// Accessibility: state is never color-only. The visual runway is aria-hidden
// (its text badges included) and a visually-hidden <ol> narrates every
// step's state for assistive tech (WCAG 1.4.1). All motion is CSS-only and
// fully disabled under prefers-reduced-motion (roadmap.css).

import { Fragment } from "react";
import { ROADMAP_STEPS, type RoadmapStepKey } from "@/lib/roadmap/config";
import type { RoadmapStatus } from "@/lib/roadmap/status";

type NodeState =
  | "dim"
  | "frontier"
  | "done"
  | "live"
  | "attention"
  | "unconfirmed";

function badgeText(s: NodeState): string {
  if (s === "done") return "Done";
  if (s === "live") return "Live";
  if (s === "frontier") return "In progress";
  if (s === "attention") return "Attention";
  if (s === "unconfirmed") return "Unconfirmed";
  return "Not started";
}

/** The sr-only narration; only "attention" diverges from the visual badge
 * (the badge stays short, the narration says what it means). */
function srText(s: NodeState): string {
  return s === "attention" ? "Needs attention" : badgeText(s);
}

/** Task steps 01-04 in order: the only steps the frontier pulse considers. */
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
      if (status.dkim.verdict === "ok") return "done";
      if (status.dkim.verdict === "missing") return "attention";
      return "unconfirmed";
    }
    if (reached[key]) return key === "scorecard" ? "live" : "done";
    if (key === frontierKey) return "frontier";
    return "dim";
  }

  const states = ROADMAP_STEPS.map((step) => stateFor(step.key));

  return (
    <div>
      <div className="rmp-runway" aria-hidden="true">
        {ROADMAP_STEPS.map((step, i) => {
          const lit =
            i > 0 &&
            reached[ROADMAP_STEPS[i - 1].key] &&
            reached[step.key];
          const nodeCls =
            "rmp-node" +
            (states[i] === "dim" ? "" : ` rmp-node--${states[i]}`) +
            (status === null && i === 0 ? " rmp-node--shimmer" : "");
          return (
            <Fragment key={step.key}>
              {i > 0 && (
                <span
                  className={"rmp-seg" + (lit ? " rmp-seg--lit" : "")}
                  // Load animation staggers left to right; only lit segments
                  // animate, so the delay index is per segment position.
                  style={
                    lit ? { animationDelay: `${(i - 1) * 150}ms` } : undefined
                  }
                />
              )}
              <div className="rmp-stop">
                <span className="rmp-node-cell">
                  <span className={nodeCls} />
                </span>
                <span className="rmp-stop-text">
                  <span className="rmp-stop-num">{step.num}</span>
                  <span className="rmp-stop-title">{step.title}</span>
                  <span className={`rmp-state rmp-state--${states[i]}`}>
                    {badgeText(states[i])}
                  </span>
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
      <ol className="sr-only">
        {ROADMAP_STEPS.map((step, i) => (
          <li key={step.key}>
            Step {i + 1}, {step.title}: {srText(states[i])}
          </li>
        ))}
      </ol>
    </div>
  );
}
