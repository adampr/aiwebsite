// Team-submitted cards on /work (§5.16): panel-reviewed cards submitted by
// XL.net staff, rendered through this ONE template. They render INSIDE
// group "05 - What We Have Built" (owner directive 2026-07-30; no separate
// numbered group), introduced by an unnumbered "From the Team" divider that
// carries the section-level provenance promise. Every card field is a
// schema-validated plain string rendered as React text nodes; submitted
// content has no path to markup.
//
// Pagination round (2026-08-04): this component is now PRESENTATIONAL -
// the page owns the single guarded publishedCards() fetch (arranged spots
// first, then newest first — §5.16 reorder), splits off the PLACED cards
// (placements.ts, rendered inside their static bays) and passes the RUN
// here and to the registry, so the index can never advertise cards this
// section failed to render. An empty list renders
// NOTHING (the hand-authored exhibits are unaffected and the page never
// breaks on this section's account). data-team-divider / data-work-card
// are the pager island's hooks for hiding the divider on static-only pages.
//
// SEAM PARITY (first derived 2026-08-05, RE-DERIVED 2026-08-29 for the
// placement round, and once more after the same-day #follow-up-emails
// conversion, 6e45b44): stripe classes key on the GLOBAL 1-based position
// of a card in the one works sequence (odd = lightline, even = plain;
// #brain at 1 is lightline), and the run is the tail of that sequence, so
// its first card's position is (every static) + (every placement in
// src/lib/work/placements.ts naming a known bay) + 1. That number is no
// longer a literal here: the page computes it (sequencePositions().runFirst)
// and passes it as `firstPosition`; a card at index i renders at
// firstPosition + i and CommunityCard derives the class from that. It IS
// still a build-time constant: the positions count the MAP, never the
// published rows, because the static classes below a placed card were
// flipped against the map, and had the run followed the rows instead, an
// unpublished placement would have moved this seam too (refuter finding).
// Today's derivation: 17 statics + 3 placements (#team-mycoach at
// position 10, closing bay 02; #team-xlant and
// #team-client-site-rescue-mirror at 13-14, inside bay 03) put the last
// static, #autotask-ci-intake, at position 20, EVEN, plain, so the run
// starts at 21, ODD, lightline. With a placed row unpublished the run
// still starts at 21 and only the seam out of that card's own bay
// double-stripes, until the map entry is removed. Inserting or
// removing an ODD number of cards anywhere before the run flips every
// hard-coded static class after that point (see placements.ts for why bay
// membership is a build-time fact), and scripts/work-placements-tests.ts
// walks the real page.tsx token stream to prove the alternation rather
// than trusting this text.
//
// HISTORY, kept because the derivation is the part that goes stale: on
// 2026-08-05 the last static was Ticket Reply Composer at 26 (even, offset
// i + 1, run starting lightline); on 2026-08-29 eight exhibits became team
// cards and it became #autotask-ci-intake at 18 (even, offset unchanged);
// later that day #follow-up-emails (position 15) was converted too, the
// last static fell to 17 (odd) and the offset moved to i (run starting
// plain), with the three statics after the removed one flipped in page.tsx;
// the placement round then put a card at 12, flipping the six statics after
// it back, and replaced the literal offset with the computed position; on
// 2026-09-04 #team-mycoach joined bay 02 and #team-xlant bay 03, moving
// the last static to 20 (even, bay 03's two statics flipped, bays 04-05
// shifted by two so their classes held).
// The offset lives here, not in work-card.tsx, because the company page
// (§5.18 /roadmap/work) opens its own alternation with no statics above it
// and must keep starting plain.

// The card template itself lives in src/components/work-card.tsx (§5.18:
// the company /roadmap/work page renders through the SAME component, with a
// company defaultCredit; the default keeps this page byte-identical).
import type { PublishedCard } from "@/lib/work/db";
import { CommunityCard } from "@/components/work-card";

export function CommunitySection({
  cards,
  firstPosition,
}: {
  cards: PublishedCard[];
  /** 1-based global position of the first run card (sequencePositions). */
  firstPosition: number;
}) {
  if (cards.length === 0) return null;
  return (
    <>
      <div className="text-center" data-team-divider>
        <span className="sys-label sys-label--center">From the Team</span>
        <p className="mx-auto mt-6 max-w-3xl text-sm">
          XL.net staff submit tools they built, with the documents to back
          them. An automated editorial panel drafts each card, argues against
          it, and holds anything it cannot verify for a human decision. Every
          claim below is drawn from the submitted documents, apart from a
          time saved figure, which is reported by the submitter and labelled
          that way on the card.
        </p>
      </div>
      {cards.map((item, i) => (
        <CommunityCard key={item.id} item={item} index={firstPosition + i} />
      ))}
    </>
  );
}
