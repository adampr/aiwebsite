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
// first, then newest first — §5.16 reorder)
// and passes the rows here and to the registry, so the index can never
// advertise cards this section failed to render. An empty list renders
// NOTHING (the hand-authored exhibits are unaffected and the page never
// breaks on this section's account). data-team-divider / data-work-card
// are the pager island's hooks for hiding the divider on static-only pages.
//
// SEAM PARITY (first derived 2026-08-05, RE-DERIVED 2026-08-29): the last
// static exhibit sits at an EVEN global position and so renders plain, which
// means the first team card must start LIGHTLINE or the seam double-stripes
// plain-on-plain. The offset lives here, not in work-card.tsx, because the
// company page (§5.18 /roadmap/work) opens its own alternation with no
// statics above it and must keep starting plain.
//
// The conclusion has survived two reshuffles and the DERIVATION is the part
// that keeps going stale, so read it off the page rather than off this
// comment. On 2026-08-05 the last static was Ticket Reply Composer at 26;
// on 2026-08-29 eight exhibits became team cards and it became
// #autotask-ci-intake at 18. Both are even, so the offset never moved. A
// future removal of an ODD number of trailing cards WOULD flip it.

// The card template itself lives in src/components/work-card.tsx (§5.18:
// the company /roadmap/work page renders through the SAME component, with a
// company defaultCredit; the default keeps this page byte-identical).
import type { PublishedCard } from "@/lib/work/db";
import { CommunityCard } from "@/components/work-card";

export function CommunitySection({ cards }: { cards: PublishedCard[] }) {
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
        <CommunityCard key={item.id} item={item} index={i + 1} />
      ))}
    </>
  );
}
