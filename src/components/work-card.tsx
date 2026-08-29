// The ONE published-card template (§5.16, §5.18). Moved VERBATIM from
// src/app/work/community.tsx so the public /work page and the company
// /roadmap/work page render submissions through the same markup; the only
// delta is the optional defaultCredit prop, whose default keeps /work
// byte-identical ("the XL.net team"). Every card field is a schema-validated
// plain string rendered as React text nodes; submitted content has no path
// to markup.
//
// `placed` (2026-08-29, src/lib/work/placements.ts): a team card lifted into
// a static bay sits ABOVE the "From the Team" divider that carries the
// section-level provenance promise, so it must disclose its own provenance
// on the card: a "From the Team" badge in the badge row. Opt-in, default
// off, so the run on /work and the §5.18 company page stay byte-identical.

import type { PublishedCard } from "@/lib/work/db";
import { formatTimeSavedPhrase } from "@/lib/work/time-saved";

export function CommunityCard({
  item,
  index,
  defaultCredit = "the XL.net team",
  placed = false,
}: {
  item: PublishedCard;
  index: number;
  defaultCredit?: string;
  placed?: boolean;
}) {
  const { card } = item;
  const credit = item.submitterName
    ? `submitted by ${item.submitterName}`
    : `submitted by ${defaultCredit}`;
  const footer = [...card.footerLine, credit].join(" · ");
  // §5.16 time saved (owner ask 2026-08-27). null when the submitter has not
  // reported one, and the line below is then not rendered at all: a "0" here
  // would read as a card claiming the work saves nobody any time, which is a
  // claim nobody made.
  const timeSaved = formatTimeSavedPhrase(item.timeSavedMinutes);
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
        {placed && <span className="badge badge--light">From the Team</span>}
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
      {/* ATTRIBUTED, and the attribution is not decoration. Everything else
          on this card came out of the panel, and the /work page opens with a
          standing promise that "Every claim below is drawn from the submitted
          documents" - this number is not: it is typed by the submitter and no
          stage of the review ever checks it. Naming the source in the line
          itself is what keeps the promise true. It sits ABOVE the footer so
          the byline stays the card's last line. */}
      {timeSaved && (
        <p className="mono mt-6 text-xs text-faint">
          Time saved · {timeSaved}, reported by the submitter
        </p>
      )}
      <p className="mono mt-6 text-xs text-faint">{footer}</p>
    </section>
  );
}
