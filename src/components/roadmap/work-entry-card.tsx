// The /work entry card on the /roadmap hub (nav restructure 2026-08-19).
//
// The signed-in top nav no longer carries a /work link for staff (and the
// hub is where every roadmap visitor lands), so each hub branch renders this
// prominent, obviously-clickable card near the top instead: one stretched-
// overlay CTA to /work in the hub's own rmp-card grammar (roadmap.css §on
// rmp-card-cta - the whole card is the tab stop, accessible name = the CTA
// text). Label varies by audience per the owner's spec: "Our Work" for the
// signed-out teaser, "XL.net Work" for every signed-in branch. Server
// component - the caller (roadmap/page.tsx or staff-hub.tsx) already knows
// the session, so nothing probes client-side.
//
// roadmap.css is imported by the /roadmap pages only, which is fine: this
// card renders nowhere else.

import Link from "next/link";

const faint = { color: "var(--xl-text-faint)" } as const;

export function WorkEntryCard({
  label,
  className,
}: {
  /** "Our Work" (signed out) or "XL.net Work" (signed in). */
  label: string;
  className?: string;
}) {
  return (
    <section className={className ?? "mx-auto max-w-3xl"}>
      {/* NOT panel--lightline: its ::before would collide with
          .rmp-card::before (the hover lightline), so the rest-state accent
          is just the modifier's border-top half, inlined. */}
      <div
        className="panel rmp-card"
        style={{ borderTop: "1px solid var(--xl-light-dim)" }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="sys-label">The Showcase</span>
          <span className="mono text-xs" style={faint}>
            /work
          </span>
        </div>
        <h2 className="mt-4 text-lg">{label}</h2>
        <p className="mt-3 text-sm">
          Every AI build XL.net publishes, in the open: product exhibits,
          team submissions and the systems behind them.
        </p>
        <Link href="/work" className="rmp-card-cta">
          See {label} <span className="rmp-arrow" aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}
