// The ONE published-card template (§5.16, §5.18). Moved VERBATIM from
// src/app/work/community.tsx so the public /work page and the company
// /roadmap/work page render submissions through the same markup; the only
// delta is the optional defaultCredit prop, whose default keeps /work
// byte-identical ("the XL.net team"). Every card field is a schema-validated
// plain string rendered as React text nodes; submitted content has no path
// to markup.

import type { PublishedCard } from "@/lib/work/db";

export function CommunityCard({
  item,
  index,
  defaultCredit = "the XL.net team",
}: {
  item: PublishedCard;
  index: number;
  defaultCredit?: string;
}) {
  const { card } = item;
  const credit = item.submitterName
    ? `submitted by ${item.submitterName}`
    : `submitted by ${defaultCredit}`;
  const footer = [...card.footerLine, credit].join(" · ");
  return (
    <section
      id={item.slug}
      data-work-card="team"
      className={
        index % 2 === 0 ? "panel rise" : "panel panel--lightline rise"
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
