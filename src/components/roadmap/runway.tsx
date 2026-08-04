// The Lightline Runway (§5.18): one luminous hairline through five diamond
// nodes, horizontal on wide screens, a vertical left rail below. Server
// component; state comes entirely from the ONE server-computed RoadmapStatus
// so the runway can never disagree with the step panels.
//
// Round 4 (owner ruling): THE NODE CARRIES THE STATE - no visible state
// words. The color grammar, enforced in roadmap.css:
//   hollow neutral   = not started (and dkim "unconfirmed"; sr text differs)
//   cyan outline     = up next (STATIC; the pulse now means working only)
//   pulsing cyan<->flare fill = working (directory import / dkim check)
//   solid cyan       = done (and scorecard "live"; sr text differs)
//   warn double-diamond = dkim attention (error flag, outside the ladder;
//                        the offset ring is a SHAPE cue, not color-only)
// Non-visual state rides an sr-only span inside each stop link (", Done"
// etc.), so the accessible name is "01 AI Governance, Done".
//
// ISLAND CONTRACT (documented here because the DOM below is server-owned):
//  - #rmp-node-directory / #rmp-sr-directory: the DirectoryCard island
//    toggles data-working on the node and rewrites the sr span's TEXT NODE
//    via nodeValue (NEVER textContent - that orphans React's text fiber and
//    breaks later refresh updates) while its auto-import runs. The server
//    never renders data-working, so hydration always matches.
//  - #rmp-node-dkim: rendered with .rmp-node--working when the 800ms status
//    race timed out (server-known); the DkimStep island stamps data-gave-up
//    on it when its poll episode ends without a verdict, demoting the pulse
//    to the static working form. The selector is scoped to
//    .rmp-node--working, so the stamp is inert after any verdict refresh.
//
// The frontier ("up next") is computed over the first four steps only; dkim
// is a verdict step and never takes it. The 04-to-05 segment lights when
// the scorecard is live AND the dkim verdict is ok. All motion is CSS-only
// and reduced-motion-safe (roadmap.css).

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
  | "working";

const faint = { color: "var(--xl-text-faint)" } as const;

/** The sr-only state phrase (the words left the screen; they must never
 * leave assistive tech). */
function srStateText(s: NodeState): string {
  if (s === "done") return "Done";
  if (s === "live") return "Live";
  if (s === "upnext") return "Up next"; // NEVER "In progress" (owner ruling)
  if (s === "attention") return "Needs attention";
  if (s === "unconfirmed") return "Unconfirmed";
  if (s === "working") return "Checking now";
  return "Not started";
}

/** Node class per state; dim renders the bare hollow base. */
function nodeClass(s: NodeState): string {
  if (s === "dim" || s === "unconfirmed") return "rmp-node";
  return `rmp-node rmp-node--${s}`;
}

/** Task steps 01-04 in order: the only steps "up next" considers. */
const UPNEXT_KEYS = ["governance", "directory", "work", "scorecard"] as const;

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
    ? (UPNEXT_KEYS.find((k) => !reached[k]) ?? null)
    : null;

  function stateFor(key: RoadmapStepKey): NodeState {
    if (!status) return "dim";
    if (key === "dkim") {
      if (status.dkim.timedOut === true) return "working";
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

  if (status === null) {
    // Teaser: pure ornament (aria-hidden) plus one sr-only sentence. Node 01
    // wears the STATIC up-next invitation (the old shimmer read as activity,
    // and pulse now exclusively means working).
    return (
      <div>
        <div className="rmp-runway" aria-hidden="true">
          {ROADMAP_STEPS.map((step, i) => (
            <Fragment key={step.key}>
              {i > 0 && segFor(i, true)}
              <div className="rmp-stop">
                <span className="rmp-node-cell">
                  <span
                    className={"rmp-node" + (i === 0 ? " rmp-node--upnext" : "")}
                  />
                </span>
                <span className="rmp-stop-text">
                  <span className="rmp-stop-num">{step.num}</span>
                  <span className="rmp-stop-title">{step.title}</span>
                </span>
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
          const nodeId =
            step.key === "directory"
              ? "rmp-node-directory"
              : step.key === "dkim"
                ? "rmp-node-dkim"
                : undefined;
          return (
            <Fragment key={step.key}>
              {i > 0 && segFor(i, false)}
              <Link href={step.href} className="rmp-stop">
                <span className="rmp-node-cell" aria-hidden="true">
                  <span id={nodeId} className={nodeClass(states[i])} />
                </span>
                <span className="rmp-stop-text">
                  <span className="rmp-stop-num">{step.num}</span>
                  <span className="rmp-stop-title">{step.title}</span>
                  <span
                    className="sr-only"
                    id={step.key === "directory" ? "rmp-sr-directory" : undefined}
                  >
                    , {srStateText(states[i])}
                  </span>
                </span>
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
