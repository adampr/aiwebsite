// The Lightline Runway (§5.18): one luminous hairline through eight diamond
// nodes, horizontal on wide screens, a vertical left rail below. Server
// component; state comes entirely from the ONE server-computed RoadmapStatus
// so the runway can never disagree with the step panels.
//
// Round 4 (owner ruling): THE NODE CARRIES THE STATE - no visible state
// words. The color grammar, enforced in roadmap.css:
//   hollow neutral   = not started
//   dashed hollow    = paid offering, booked off-portal (workshop, cohort);
//                      a SHAPE cue, not a hue: these steps are outside the
//                      progress ladder entirely, never dim-vs-done
//   gray-core diamond = examined: the system RAN and found nothing to show
//                      (directory stamped-zero)
//   cyan outline     = up next (STATIC; the pulse means working only)
//   pulsing cyan<->flare fill = working (directory import, island-toggled)
//   solid cyan       = done (and scorecard "live"; sr text differs)
// Non-visual state rides an sr-only span inside each stop link (", Done"
// etc.), so the accessible name is "01 AI Governance, Done".
//
// The warn double-diamond retired with the Verified Email step (its DKIM
// verdict is now a sub-surface of Submit AI-Built Work and never reaches
// the runway). Reserved in the grammar if attention ever returns.
//
// There is deliberately no "working" NodeState: the only pulsing node left is
// the directory's, and the island drives it with the data-working ATTRIBUTE
// plus literal strings of its own, so a server-rendered working class would
// be an unreachable path pointing at CSS that no longer exists.
//
// ISLAND CONTRACT (documented here because the DOM below is server-owned):
//  - #rmp-node-directory / #rmp-sr-directory: the DirectoryCard island
//    toggles data-working on the node and rewrites the sr span's TEXT NODE
//    via nodeValue (NEVER textContent - that orphans React's text fiber and
//    breaks later refresh updates) while its auto-import runs. The server
//    never renders data-working, so hydration always matches.
//
// PAID STEPS (03 workshop, 08 cohort) are bought on /builders and a purchase
// is invisible to this server, so they never take a progress state, never
// take the frontier ring, and are TRANSPARENT to segment lighting: a segment
// asks the nearest TRACKED stop on each side. The line therefore claims task
// progress only, and the node claims offering status only. Their fee token
// is aria-hidden (screen readers would voice "$495/mo" as "slash m o"); the
// sr channel says "Booked separately" and the card below speaks the price.
//
// The frontier ("up next") is computed over the six TRACKED steps only
// (TRACKED_STEP_KEYS in config.ts, pinned tracked-XOR-paid by
// scripts/roadmap-tests.ts). All motion is CSS-only and
// reduced-motion-safe (roadmap.css).

import { Fragment } from "react";
import Link from "next/link";
import {
  ROADMAP_STEPS,
  TRACKED_STEP_KEYS,
  isPaidStep,
  type RoadmapStepKey,
  type TrackedStepKey,
} from "@/lib/roadmap/config";
import type { RoadmapStatus } from "@/lib/roadmap/status";

type NodeState =
  | "dim"
  | "upnext"
  | "done"
  | "live"
  /** Round 5: the system RAN and there is nothing to show - directory
   * stamped-zero. One visual with "checked" (gray-core diamond). */
  | "examined"
  /** Paid, bought off-portal: outside the progress ladder entirely. */
  | "offered";

const faint = { color: "var(--xl-text-faint)" } as const;

/** The sr-only state phrase (the words left the screen; they must never
 * leave assistive tech). */
function srStateText(s: NodeState): string {
  if (s === "done") return "Done";
  if (s === "live") return "Live";
  if (s === "upnext") return "Up next"; // NEVER "In progress" (owner ruling)
  // Says only what is true: the purchase happens outside this workspace and
  // is not tracked here. NEVER "Open enrollment" - a session can be sold out
  // or between dates, which this server cannot know.
  if (s === "offered") return "Booked separately";
  // Role-NEUTRAL on purpose (refuter): members cannot "add people by hand";
  // the imperative lives on the admin card's CTA, not here.
  if (s === "examined") return "Searched, none found on Apollo";
  return "Not started";
}

/** Node class per state; dim renders the bare hollow base, offered adds the
 * dashed border (shape cue, no new hue), examined the gray core. */
function nodeClass(s: NodeState): string {
  if (s === "dim") return "rmp-node";
  if (s === "examined") return "rmp-node rmp-node--examined";
  return `rmp-node rmp-node--${s}`;
}

function isTracked(k: RoadmapStepKey): k is TrackedStepKey {
  return (TRACKED_STEP_KEYS as readonly string[]).includes(k);
}

/** ornament: the aria-hidden no-state render (teaser + staff hub). The
 * teaser keeps the static up-next invitation on node 01; the staff hub
 * passes noInvite (a signed-in surface whose cards show real counts must
 * not wear a false wayfinding ring) and its own sr sentence. */
export function RoadmapRunway({
  status,
  srSummary,
  noInvite = false,
}: {
  status: RoadmapStatus | null;
  srSummary?: string;
  noInvite?: boolean;
}) {
  // "reached" drives segment lighting: done for the task steps, live for the
  // scorecard (never "done": it is ongoing). Paid steps have no entry: there
  // is nothing to reach.
  const reached: Record<TrackedStepKey, boolean> = status
    ? {
        governance: status.governance.done,
        directory: status.directory.done,
        work: status.work.done,
        request: status.request.done,
        requested: status.requested.live,
        scorecard: status.scorecard.live,
      }
    : {
        governance: false,
        directory: false,
        work: false,
        request: false,
        requested: false,
        scorecard: false,
      };

  const frontierKey = status
    ? (TRACKED_STEP_KEYS.find((k) => !reached[k]) ?? null)
    : null;

  function stateFor(key: RoadmapStepKey): NodeState {
    if (!status) return "dim";
    // Purchases are server-invisible; never claim more than "this is bought
    // elsewhere".
    if (!isTracked(key)) return "offered";
    // Precedence: done > up next (frontier) > examined > dim. Up next beats
    // examined so the runway never loses its single wayfinding ring; the
    // adjacent card still tells the searched-zero story in words.
    // requested is an ongoing board like the scorecard: its reached state
    // voices "Live", never "Done".
    if (reached[key])
      return key === "scorecard" || key === "requested" ? "live" : "done";
    if (key === frontierKey) return "upnext";
    if (
      key === "directory" &&
      status.directory.everImported &&
      status.directory.people === 0
    )
      return "examined";
    return "dim";
  }

  const states = ROADMAP_STEPS.map((step) => stateFor(step.key));

  /** Walk outward from index i until a TRACKED stop answers. Paid stops are
   * pass-through beads, so segments 02-03 and 03-04 both light once
   * directory and work are reached, and the line flows past the workshop
   * without claiming it. Walking off the RIGHT end is vacuously reached (the
   * tail segment into the cohort follows the scorecard, rather than staying
   * permanently dark on a fully engaged company's runway); walking off the
   * left end must never happen, because ROADMAP_STEPS[0] is tracked, and
   * returning false there keeps a future reorder from lighting a segment out
   * of a stop nobody has bought. */
  function reachedToward(i: number, dir: -1 | 1): boolean {
    for (let j = i; j >= 0 && j < ROADMAP_STEPS.length; j += dir) {
      const k = ROADMAP_STEPS[j].key;
      if (isTracked(k)) return reached[k];
    }
    return dir === 1;
  }

  // containerHidden: the teaser wraps everything in one aria-hidden
  // container, so its segments need no individual attribute; the signed-in
  // branch has NO container-level aria-hidden, so each seg carries its own.
  function segFor(i: number, containerHidden: boolean) {
    const lit = reachedToward(i - 1, -1) && reachedToward(i, 1);
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

  /** The visible price token on a paid stop. aria-hidden: it is decorative
   * reinforcement, and the sr channel already says "Booked separately"
   * without spelling a slash. */
  function feeFor(step: (typeof ROADMAP_STEPS)[number]) {
    if (!isPaidStep(step)) return null;
    return (
      <span className="rmp-stop-fee" aria-hidden="true">
        {step.fee}
      </span>
    );
  }

  if (status === null) {
    // Ornament render: aria-hidden diamonds plus one sr-only sentence.
    // Teaser: node 01 wears the STATIC up-next invitation (the old shimmer
    // read as activity, and pulse now exclusively means working). Staff hub:
    // noInvite drops the ring (a signed-in surface with real counts on its
    // cards must not claim "up next: AI Governance").
    return (
      <div>
        <div className="rmp-runway" aria-hidden="true">
          {ROADMAP_STEPS.map((step, i) => (
            <Fragment key={step.key}>
              {i > 0 && segFor(i, true)}
              <div className="rmp-stop">
                <span className="rmp-node-cell">
                  <span
                    className={
                      isPaidStep(step)
                        ? "rmp-node rmp-node--offered"
                        : "rmp-node" +
                          (i === 0 && !noInvite ? " rmp-node--upnext" : "")
                    }
                  />
                </span>
                <span className="rmp-stop-text">
                  <span className="rmp-stop-num">{step.num}</span>
                  <span className="rmp-stop-title">{step.title}</span>
                  {feeFor(step)}
                </span>
              </div>
            </Fragment>
          ))}
        </div>
        <p className="sr-only">
          {srSummary ?? "Eight steps, none started yet."}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="rmp-runway">
        {ROADMAP_STEPS.map((step, i) => {
          const nodeId =
            step.key === "directory" ? "rmp-node-directory" : undefined;
          return (
            <Fragment key={step.key}>
              {i > 0 && segFor(i, false)}
              <Link href={step.href} className="rmp-stop">
                {/* data-state feeds the pure-CSS hover/focus tooltip (round
                    6, owner ask): the same phrase assistive tech hears. The
                    cell is aria-hidden, so the tooltip never duplicates the
                    sr span. The DirectoryCard island swaps it to "Checking
                    now" alongside data-working and restores the prior value
                    (same capture pattern as the sr text). */}
                <span
                  className="rmp-node-cell"
                  aria-hidden="true"
                  data-state={srStateText(states[i])}
                >
                  <span id={nodeId} className={nodeClass(states[i])} />
                </span>
                <span className="rmp-stop-text">
                  <span className="rmp-stop-num">{step.num}</span>
                  <span className="rmp-stop-title">{step.title}</span>
                  {feeFor(step)}
                  {/* ONE expression = ONE text fiber: the DirectoryCard
                      island rewrites this span's firstChild.nodeValue, and
                      a two-node child list (static ", " + phrase) would
                      point it at the wrong node (refuter-verified against
                      renderToString output). */}
                  <span
                    className="sr-only"
                    id={step.key === "directory" ? "rmp-sr-directory" : undefined}
                  >
                    {", " + srStateText(states[i])}
                  </span>
                </span>
              </Link>
            </Fragment>
          );
        })}
      </div>
      <p className="mono mt-6 text-center text-xs" style={faint}>
        Start wherever helps most. Two steps are paid training, booked on the
        Builders page.
      </p>
    </div>
  );
}
