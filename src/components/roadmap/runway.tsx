// The Lightline Runway (§5.18): one luminous hairline through four diamond
// nodes, horizontal on desktop, a vertical left rail on mobile. Server
// component; state comes entirely from the ONE server-computed RoadmapStatus
// so the runway can never disagree with the stat strip or step panels.
// status === null renders the public teaser's zero state (all nodes dim,
// node 01 shimmering).
//
// Accessibility: state is never color-only. The visual runway is aria-hidden
// (its text badges included) and a visually-hidden <ol> narrates every
// step's state for assistive tech (WCAG 1.4.1). All motion is CSS-only and
// fully disabled under prefers-reduced-motion (roadmap.css).

import { Fragment } from "react";
import { ROADMAP_STEPS } from "@/lib/roadmap/config";
import type { RoadmapStatus } from "@/lib/roadmap/status";

type NodeState = "dim" | "frontier" | "done" | "live";

function badgeText(s: NodeState): string {
  if (s === "done") return "Done";
  if (s === "live") return "Live";
  if (s === "frontier") return "In progress";
  return "Not started";
}

export function RoadmapRunway({ status }: { status: RoadmapStatus | null }) {
  const done = status
    ? [
        status.governance.done,
        status.directory.done,
        status.work.done,
        // Step 4 is never "done": a scorecard is ongoing. Live counts as
        // reached for segment lighting.
        status.scorecard.live,
      ]
    : [false, false, false, false];
  const frontier = done.indexOf(false); // -1 = everything reached
  const states: NodeState[] = done.map((d, i) => {
    if (d) return i === 3 ? "live" : "done";
    if (status && i === frontier) return "frontier";
    return "dim";
  });

  return (
    <div>
      <div className="rmp-runway" aria-hidden="true">
        {ROADMAP_STEPS.map((step, i) => {
          const lit = i > 0 && done[i - 1] && done[i];
          const nodeCls =
            "rmp-node" +
            (states[i] === "done"
              ? " rmp-node--done"
              : states[i] === "live"
                ? " rmp-node--live"
                : states[i] === "frontier"
                  ? " rmp-node--frontier"
                  : "") +
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
            Step {i + 1}, {step.title}: {badgeText(states[i])}
          </li>
        ))}
      </ol>
    </div>
  );
}
