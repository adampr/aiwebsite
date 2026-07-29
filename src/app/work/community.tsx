// "From the Team" section on /work (§5.16): panel-reviewed cards submitted
// by XL.net staff, read from Postgres and rendered through this ONE template.
// Every card field is a schema-validated plain string rendered as React text
// nodes; submitted content has no path to markup. A DB failure or an empty
// table renders NOTHING (the 24 hand-authored exhibits are unaffected and
// the page never breaks on this section's account).

import { publishedCards, type PublishedCard } from "@/lib/work/db";

function CommunityCard({ item, index }: { item: PublishedCard; index: number }) {
  const { card } = item;
  const credit = item.submitterName
    ? `submitted by ${item.submitterName}`
    : "submitted by the XL.net team";
  const footer = [...card.footerLine, credit].join(" · ");
  return (
    <section
      id={item.slug}
      className={
        index % 2 === 0 ? "panel panel--lightline rise" : "panel rise"
      }
    >
      <div className="flex flex-wrap items-center gap-4">
        <span className="badge">Built</span>
        <span className="badge badge--light">{card.categoryBadge}</span>
      </div>
      <h2 className="mt-6">{card.title}</h2>
      <p className="mt-4 text-sm">{card.summary}</p>
      {card.body.map((p, i) => (
        <p key={i} className="mt-4 text-sm">
          {p}
        </p>
      ))}
      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {card.facets.map((f, i) => (
          <div key={i} className="border-t border-[var(--xl-line)] pt-4">
            <h3 className="mono text-xs uppercase tracking-[0.2em] text-light">
              <span className="text-faint">{`0${i + 1} · `}</span>
              {f.label}
            </h3>
            <p className="mt-3 text-sm">{f.text}</p>
          </div>
        ))}
      </div>
      <p className="mono mt-6 text-xs text-faint">{footer}</p>
    </section>
  );
}

export async function CommunitySection() {
  let cards: PublishedCard[] = [];
  try {
    cards = await publishedCards();
  } catch {
    // render nothing; the static exhibits above are the page
    return null;
  }
  if (cards.length === 0) return null;
  return (
    <section aria-label="From the Team" className="space-y-16">
      <div className="text-center">
        <span className="sys-label sys-label--center">06 · From the Team</span>
        <h2 className="mt-8">Tools our engineers built for their own work</h2>
        <p className="mx-auto mt-6 max-w-3xl text-sm">
          XL.net staff submit tools they built, with the documents to back
          them. An automated editorial panel drafts each card, argues against
          it, and holds anything it cannot verify for a human decision. Every
          claim below is drawn from the submitted documents.
        </p>
      </div>
      {cards.map((item, i) => (
        <CommunityCard key={item.id} item={item} index={i} />
      ))}
    </section>
  );
}
