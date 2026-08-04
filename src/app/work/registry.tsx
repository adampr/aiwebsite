// /work registry (pagination round, 2026-08-04): a mono index of every
// exhibit, grouped by bay, rendered after the manifesto. It is the
// random-access instrument for the console pager below it: rows are plain
// anchor links to each card's #slug, the pager island reveals paged-out
// targets on click. The registry itself never paginates and never hides -
// it is the always-complete, crawlable, Ctrl-F-able map of the page.
//
// Static rows come from static-titles.json (GENERATED - the snapshot script
// emits bays + exhibits from page.tsx, so these rows can never drift from
// the frozen card copy). Team rows come from the page's single guarded
// publishedCards() fetch, in the exact order CommunitySection renders them
// (newest first), so registry numbering and DOM order never disagree.
// Numbering is presentational and continuous across the whole sequence,
// padded to one uniform width per render (a new publish renumbers team
// rows; the anchors, not the numbers, are the stable contract).

import staticTitles from "@/lib/work/static-titles.json";
import type { PublishedCard } from "@/lib/work/db";

interface RegistryRow {
  id: string;
  title: string;
}

export function WorkRegistry({ team }: { team: PublishedCard[] }) {
  const { bays, exhibits } = staticTitles;
  const total = exhibits.length + team.length;
  const width = Math.max(2, String(total).length);

  // Number the whole sequence before rendering (continuous across bays,
  // uniform width; team rows continue after the last static in bay 05).
  const flat: (RegistryRow & { bay: string })[] = bays.flatMap((bay) => {
    const rows = exhibits
      .filter((e) => e.bay === bay.n)
      .map((e) => ({ id: e.id, title: e.title, bay: bay.n }));
    if (bay.n === "05") {
      rows.push(
        ...team.map((t) => ({ id: t.slug, title: t.card.title, bay: "05" }))
      );
    }
    return rows;
  });
  const numbered = flat.map((row, i) => ({
    ...row,
    num: String(i + 1).padStart(width, "0"),
  }));
  const groups = bays.map((bay) => ({
    n: bay.n,
    name: bay.name,
    rows: numbered.filter((row) => row.bay === bay.n),
  }));

  return (
    <nav aria-label="Works index" className="work-registry">
      <a className="work-registry-skip" href="#works-start">
        Skip works index
      </a>
      {groups.map((group) => (
        <div key={group.n} className="work-registry-group">
          <span className="sys-label">
            {group.n} · {group.name}
          </span>
          <ul>
            {group.rows.map((row) => (
              <li key={row.id}>
                <a href={`#${row.id}`}>
                  <span className="work-registry-n">{row.num}</span> ·{" "}
                  {row.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
