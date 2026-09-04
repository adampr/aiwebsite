// /work team-card PLACEMENTS (owner directive 2026-08-29): a published
// team card (§5.16, a `work_submissions` row) can be lifted out of the
// "From the Team" run at the foot of bay 05 and rendered INSIDE one of the
// static bays, after that bay's hand-authored exhibits. Seeded 2026-08-29
// with "Client Site Rescue Mirror" into "03 · Client Delivery"; on
// 2026-09-04 (owner directive) "MyCoach" joined "02 · What It Runs" and
// "XLAnt" joined "03 · Client Delivery".
//
// WHY THIS IS A CODE MAP AND NOT A DB COLUMN. The static exhibits in
// src/app/work/page.tsx carry HARD-CODED stripe classes (`panel rise` at an
// even global position, `panel panel--lightline rise` at an odd one), so a
// card that joins a bay shifts the global position, and therefore the
// stripe, of every static exhibit after it. Bay membership is a build-time
// fact for that reason: the exhibit classes below the placement were
// flipped in the same change, and the parity test walks the whole rendered
// order (scripts/work-placements-tests.ts). A DB column could move a card
// between bays without a deploy and would silently double-stripe a seam.
// Rank WITHIN a lane stays DB curation (display_rank, §5.16 reorder): the
// splitter preserves publishedCards() order inside both the placed lists and
// the run. Corollary worth stating: while a placed slug is NOT published
// (withdrawn, held for a re-run, DB down) the statics after its bay keep
// their flipped classes, so the seam INSIDE that bay (its last static to the
// next bay's first) double-stripes until the placement is removed from this
// map, and adding a placement means flipping the trailing statics again.
// That is the ONLY seam a missing row costs: sequencePositions() below
// advances every later position by the MAP entries naming a known bay, not
// by what is published, so the run's first position and every later placed
// card's position are build-time constants, the same ones the flipped
// classes were written against, and the "From the Team" seam stays correct
// with the row absent (refuter finding, 2026-08-29).
//
// The map is keyed by the row's slug (`team-<slugified-title>`, minted at
// publish, unique per lane). A placement naming a bay that static-titles.json
// does not know is a plain typo and must not take the page down: the card
// falls back to the run, and that fallback is test-pinned.

import type { PublishedCard } from "./db";

/** Team-card slug -> static bay number, as printed in static-titles.json's
 * `bays[].n` ("01".."05"). */
export const TEAM_CARD_PLACEMENTS: Readonly<Record<string, string>> =
  Object.freeze({
    "team-client-site-rescue-mirror": "03",
    "team-mycoach": "02",
    "team-xlant": "03",
  });

export interface PlacementSplit {
  /** Bay number -> the placed cards for that bay, in publishedCards() order.
   * Only bays that received at least one card are present as keys. */
  placed: Map<string, PublishedCard[]>;
  /** Everything else, in publishedCards() order: the "From the Team" run. */
  run: PublishedCard[];
}

/** Pure. Splits the guarded publishedCards() result into per-bay placed
 * lists and the remaining run. Unknown slugs, and slugs whose placement
 * names a bay absent from `bays`, go to the run. Order is preserved within
 * every list. */
export function splitPlacements(
  cards: readonly PublishedCard[],
  bays: readonly string[],
  placements: Readonly<Record<string, string>> = TEAM_CARD_PLACEMENTS
): PlacementSplit {
  const known = new Set(bays);
  const placed = new Map<string, PublishedCard[]>();
  const run: PublishedCard[] = [];
  for (const card of cards) {
    const bay = Object.prototype.hasOwnProperty.call(placements, card.slug)
      ? placements[card.slug]
      : undefined;
    if (bay === undefined || !known.has(bay)) {
      run.push(card);
      continue;
    }
    const list = placed.get(bay);
    if (list) list.push(card);
    else placed.set(bay, [card]);
  }
  return { placed, run };
}

export interface SequencePositions {
  /** Bay number -> the 1-based GLOBAL position of that bay's first placed
   * card (present for every bay in `bays`, whether or not it has placed
   * cards, so a bay wrapper can always ask). */
  placedStart: Map<string, number>;
  /** 1-based global position of the first card of the "From the Team" run:
   * every static plus every known-bay MAP entry, plus one. A build-time
   * constant, whatever the DB holds. */
  runFirst: number;
}

/** Pure. Walks the bays in order, counting each bay's statics and then the
 * MAP entries that name it (a known bay; an entry naming a bay absent from
 * `bays` counts zero, matching its fallback to the run), to give every
 * placed list and the run their first global position. Global position is
 * what the stripe classes key on (odd = lightline, even = plain, `#brain`
 * at 1 is lightline), so this is the one arithmetic the seam parity rests
 * on, and it deliberately does NOT read the published rows: the static
 * classes were flipped against the map, so the positions must follow the
 * map too, or an unpublished placement would also shift the run's seam. */
export function sequencePositions(
  exhibits: readonly { bay: string }[],
  bays: readonly string[],
  placements: Readonly<Record<string, string>> = TEAM_CARD_PLACEMENTS
): SequencePositions {
  const known = new Set(bays);
  const mapped = new Map<string, number>();
  for (const bay of Object.values(placements)) {
    if (known.has(bay)) mapped.set(bay, (mapped.get(bay) ?? 0) + 1);
  }
  const placedStart = new Map<string, number>();
  let pos = 1;
  for (const bay of bays) {
    pos += exhibits.filter((e) => e.bay === bay).length;
    placedStart.set(bay, pos);
    pos += mapped.get(bay) ?? 0;
  }
  return { placedStart, runFirst: pos };
}
