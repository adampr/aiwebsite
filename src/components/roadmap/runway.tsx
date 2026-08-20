// The Lightline Runway (§5.18): one luminous hairline through eleven diamond
// nodes, horizontal on wide screens, a vertical left rail below. Server
// component; state comes entirely from the ONE server-computed status
// bundle (RunwayStatus below: RoadmapStatus for the company lane,
// StaffRoadmapStatus for staff) so the runway can never disagree with the
// step panels. It renders on the hubs AND, since the staff-parity round,
// in the (steps) shell (layout.tsx) above every step page. The hubs add
// their one-line stats <p> below the runway; the (steps) shell renders it
// bare - hub copy never lives here.
//
// Round 4 (owner ruling): THE NODE CARRIES THE STATE - no visible state
// words. The color grammar, enforced in roadmap.css:
//   hollow neutral   = not started
//   dashed hollow    = paid offering, booked off-portal (workshop, cohort);
//                      a SHAPE cue, not a hue: these steps are outside the
//                      progress ladder entirely, never dim-vs-done
//   bright dashed    = paid offering with admin-attested attendance > 0
//                      (owner override 2026-08-20): the up-next brightness
//                      recipe on the dashed shape; a MODIFIER on offered
//                      like partial, never a state, and a node-only claim -
//                      see the PAID STEPS note below
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
//  - DirectoryCard (the hub card) is the ONLY driver. The (steps) shell
//    runway emits the same ids on step pages, where they are deliberately
//    UNDRIVEN during DirectoryTable imports (the table's busy UI and the
//    post-import router.refresh() tell the story); never add a second
//    driver - two writers of one nodeValue is how the contract breaks.
//
// PAID STEPS (03 workshop, 08 cohort) are bought on /builders and a purchase
// is invisible to this server, so they never take a progress state, never
// take the frontier ring, and are TRANSPARENT to segment lighting: a segment
// asks the nearest TRACKED stop on each side. The line therefore claims task
// progress only, and the node claims offering status only. Their fee token
// is aria-hidden (screen readers would voice "$495/mo" as "slash m o"); the
// sr channel says "Booked separately" and the card below speaks the price.
// ATTENDED (owner override 2026-08-20, NODE VISUAL only): when the lane's
// admin-attested attendance count for a paid step is > 0, the node layers
// rmp-node--attended over --offered (bright outline, dash kept) and the sr
// phrase grows ", {n} attended". Everything else is deliberately untouched:
// attendance never lights a segment, never moves the frontier, and never
// counts toward the progress percentage - it is still not task progress,
// the node just stops looking identical on a lane people actually attended.
//
// The frontier ("up next") is computed over the nine TRACKED steps only
// (TRACKED_STEP_KEYS in config.ts, pinned tracked-XOR-paid by
// scripts/roadmap-tests.ts). All motion is CSS-only and
// reduced-motion-safe (roadmap.css).
//
// PARTIAL (§5.20): step 09 alone can be HALF done, and half is a MODIFIER
// layered over the state above rather than a seventh NodeState. See
// nodeClass for the argument.

import { Fragment } from "react";
import Link from "next/link";
import {
  ROADMAP_STEPS,
  TRACKED_STEP_KEYS,
  isPaidStep,
  type RoadmapStepKey,
  type TrackedStepKey,
} from "@/lib/roadmap/config";

/** The runway's structural input (staff-parity round): exactly the fields
 * this component reads. RoadmapStatus and StaffRoadmapStatus both satisfy
 * it, so ONE component serves the company hub, the staff hub, and the
 * (steps) shell with no adapters and no fake DkimCheck anywhere. */
export type RunwayStatus = {
  governance: { done: boolean };
  directory: { done: boolean; people: number; everImported: boolean };
  work: { done: boolean };
  request: { done: boolean };
  requested: { live: boolean };
  scorecard: { live: boolean };
  /** §5.20. `partial` is a HALF, not a state of its own: see the partial
   * note above nodeClass. */
  secure: { done: boolean; partial: boolean };
  data: { done: boolean };
  tools: { done: boolean };
  /** Admin-attested paid-step head counts (owner override 2026-08-20).
   * OPTIONAL: both real bundles (RoadmapStatus, StaffRoadmapStatus) carry it
   * required, so every authenticated caller wires it just by passing its
   * existing status object - no separate prop, no adapter, and the runway
   * can never disagree with the paid cards below it. The teaser passes
   * status={null} and stays attendance-free. > 0 only brightens the offered
   * node and joins its sr phrase; see the PAID STEPS note above. */
  attendance?: { workshop: number; cohort: number };
};

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

/** The sr-only state phrase (the words left the screen; they must never
 * leave assistive tech). `partial` is layered on top rather than being its
 * own state, so a half-done step that is ALSO the frontier still says both
 * things instead of one of them silently winning. */
function srStateText(s: NodeState, partial = false, attended = 0): string {
  if (partial) return s === "upnext" ? "Half done, up next" : "Half done";
  // Attended layers over OFFERED only (owner override 2026-08-20), the same
  // way partial layers over its states. Guarding on the state here makes a
  // tracked step structurally unable to voice attendance, and the phrase
  // stays availability-neutral: a head count is a fact about people, never
  // a claim about enrollment or progress.
  if (s === "offered" && attended > 0)
    return `Booked separately, ${attended} attended`;
  return srBaseText(s);
}

function srBaseText(s: NodeState): string {
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

/**
 * Node class per state; dim renders the bare hollow base, offered adds the
 * dashed border (shape cue, no new hue), examined the gray core.
 *
 * PARTIAL IS A MODIFIER, NOT A STATE (§5.20). Step 09 is the only step that
 * can be half done, and half-done is orthogonal to "is this where you
 * should go next": the fill says how much is finished, the up-next ring
 * says where the frontier is. Modelling partial as a sixth NodeState would
 * force one of those two facts to silently win, and a company that has done
 * half of step 09 while it is also the frontier would either lose the only
 * wayfinding ring on the runway or lose the fact that it is half done.
 * Layering keeps both. The visual is a diamond filled on ONE SIDE ONLY
 * (roadmap.css), which is a shape cue rather than a hue, per the standing
 * rule that state must survive a colorblind reading.
 *
 * ATTENDED IS THE SECOND MODIFIER (owner override 2026-08-20), layered by
 * the same argument: whether people attended is orthogonal to what the
 * state machine can ever say about a paid step ("offered" is its only
 * state), so a seventh NodeState would fork the offered branch for one
 * border repaint. It composes with "offered" ONLY - partial exists only on
 * tracked step 09 and attended only on the two untracked paid keys
 * (attendedFor), so the two modifiers can never meet on one node.
 */
function nodeClass(s: NodeState, partial = false, attended = false): string {
  const base =
    s === "dim"
      ? "rmp-node"
      : s === "examined"
        ? "rmp-node rmp-node--examined"
        : `rmp-node rmp-node--${s}`;
  if (partial) return `${base} rmp-node--partial`;
  return attended && s === "offered" ? `${base} rmp-node--attended` : base;
}

function isTracked(k: RoadmapStepKey): k is TrackedStepKey {
  return (TRACKED_STEP_KEYS as readonly string[]).includes(k);
}

/** The runway's background stage (owner ask, staff-parity round): the SAME
 * .beams ornament the homepage CTA wears - faint blurred vertical light
 * shafts drifting left to right forever (futurism.css xl-beams, 30s
 * infinite alternate; static under reduced motion; light-theme override in
 * futurism.css). One wrapper component so the hub, the staff hub, the
 * (steps) shell, and the teaser cannot drift. The z-10 inner keeps the
 * stop links above the positioned ::before; the ::before is
 * pointer-events:none and invisible to assistive tech (empty content). */
export function RunwayStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="beams relative overflow-hidden py-6">
      <div className="relative z-10">{children}</div>
    </div>
  );
}

/** ornament: the aria-hidden no-state render (signed-out teaser ONLY since
 * the staff-parity round; the staff hub now passes real status). Node 01
 * keeps the static up-next invitation ring.
 *
 * hrefs: per-step link overrides (staff lane: STAFF_STEP_HREFS). Default is
 * the company step.href. The ornament branch renders no links, so the map
 * only applies to the status render. */
export function RoadmapRunway({
  status,
  srSummary,
  hrefs,
}: {
  status: RunwayStatus | null;
  srSummary?: string;
  hrefs?: Readonly<Record<RoadmapStepKey, string>>;
}) {
  // "reached" drives segment lighting: done for the task steps, live for the
  // scorecard (never "done": it is ongoing). Paid steps have no entry: there
  // is nothing to reach.
  // A HALF-done step is deliberately NOT "reached": the lightline claims
  // completed ground, so lighting the segment out of a half-finished step
  // would overstate it. The node itself still shows the half.
  const reached: Record<TrackedStepKey, boolean> = status
    ? {
        governance: status.governance.done,
        directory: status.directory.done,
        work: status.work.done,
        request: status.request.done,
        requested: status.requested.live,
        scorecard: status.scorecard.live,
        secure: status.secure.done,
        data: status.data.done,
        tools: status.tools.done,
      }
    : {
        governance: false,
        directory: false,
        work: false,
        request: false,
        requested: false,
        scorecard: false,
        secure: false,
        data: false,
        tools: false,
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
    // NB: on the staff lane examined is unreachable (governance is
    // constantly reached, so an unreached directory is always the frontier
    // and up-next wins by this precedence); the stamped-zero story is told
    // by the directory card's copy instead.
    if (
      key === "directory" &&
      status.directory.everImported &&
      status.directory.people === 0
    )
      return "examined";
    return "dim";
  }

  /** Only step 09 can be half done, and never while it is fully done. */
  function partialFor(key: RoadmapStepKey): boolean {
    return (
      key === "secure" && !!status && status.secure.partial && !status.secure.done
    );
  }

  /** Admin-attested head count (owner override 2026-08-20): only the two
   * UNTRACKED (= paid, tracked-XOR-paid pin) keys can carry one, which is
   * what keeps "attended" structurally an offered-only modifier. Feeds the
   * node class (as > 0) and the sr phrase (as the number); segments, the
   * frontier and the percentage never read it. */
  function attendedFor(key: RoadmapStepKey): number {
    if (!status || isTracked(key)) return 0;
    return status.attendance?.[key] ?? 0;
  }

  const states = ROADMAP_STEPS.map((step) => stateFor(step.key));
  const partials = ROADMAP_STEPS.map((step) => partialFor(step.key));
  const attendeds = ROADMAP_STEPS.map((step) => attendedFor(step.key));

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
    // Ornament render (signed-out teaser only): aria-hidden diamonds plus
    // one sr-only sentence. Node 01 wears the STATIC up-next invitation
    // (the old shimmer read as activity, and pulse now exclusively means
    // working).
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
                        : "rmp-node" + (i === 0 ? " rmp-node--upnext" : "")
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
          {srSummary ?? "Eleven steps, none started yet."}
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
              <Link href={hrefs?.[step.key] ?? step.href} className="rmp-stop">
                {/* data-state feeds the pure-CSS hover/focus tooltip (round
                    6, owner ask): the same phrase assistive tech hears. The
                    cell is aria-hidden, so the tooltip never duplicates the
                    sr span. The DirectoryCard island swaps it to "Checking
                    now" alongside data-working and restores the prior value
                    (same capture pattern as the sr text). */}
                <span
                  className="rmp-node-cell"
                  aria-hidden="true"
                  data-state={srStateText(states[i], partials[i], attendeds[i])}
                  // Feeds the tier-2 tooltip, where the visible title is
                  // clipped (roadmap.css). Sighted users on a step page have
                  // no cards to read the title from at that width, so the
                  // tooltip carries it.
                  data-title={step.title}
                >
                  <span
                    id={nodeId}
                    className={nodeClass(states[i], partials[i], attendeds[i] > 0)}
                  />
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
                    {", " + srStateText(states[i], partials[i], attendeds[i])}
                  </span>
                </span>
              </Link>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
