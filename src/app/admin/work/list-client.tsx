"use client";

// /admin/work list browser (§5.16, 2026-08-31): the two-section triage and
// the live search. page.tsx (a server component) still fetches and renders
// every row; it hands each one over as pre-rendered JSX plus a lowercased
// haystack string, and this island only decides which section a row sits
// in and whether the current query hides it. Hidden rows stay MOUNTED (the
// `hidden` attribute, not an unmount), so a row's WorkAdminActions state
// (its error message, a half-typed spot number) and its `sub-<id>` anchor
// survive typing. Initial render is the empty query with everything shown,
// identical on the server and the client, so hydration cannot disagree.
// The query lives in component state only: nothing persisted, no URL param.

import { useEffect, useState, type ReactNode } from "react";

export type WorkSubmissionItem = {
  id: string;
  /** Waits on an admin decision (held / pending_approval / failed). */
  attention: boolean;
  /** Lowercased searchable text, built server-side by page.tsx. */
  haystack: string;
  /** The row, rendered by page.tsx exactly as before the triage existed. */
  node: ReactNode;
};

export function WorkSubmissionsBrowser({
  items,
}: {
  items: WorkSubmissionItem[];
}) {
  const [query, setQuery] = useState("");
  // Whitespace-separated tokens, ALL of which must appear somewhere in the
  // haystack: "luke held" finds Luke's held row even though the email and
  // the status sit far apart in the string (refuter NIT, 2026-08-31).
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const searching = tokens.length > 0;
  const hit = (it: WorkSubmissionItem) =>
    !searching || tokens.every((t) => it.haystack.includes(t));
  // Same-page `#sub-<id>` links (the Uploaded files ledger below links up to
  // its submission row) cannot scroll to a row the query hides: `hidden` is
  // display:none and :target cannot override a React-controlled attribute.
  // Clearing the query on such a hash change reveals every row; the browser
  // then performs the fragment scroll on the next frame. First-load email
  // deep links never hit this (initial render is the empty query).
  useEffect(() => {
    const onHash = () => {
      if (/^#sub-/.test(window.location.hash)) setQuery("");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Newest-first order inside each section is the query's order, preserved
  // by filter.
  const attention = items.filter((it) => it.attention);
  const rest = items.filter((it) => !it.attention);
  return (
    <div className="space-y-6">
      <input
        type="search"
        className="input w-full max-w-md"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search title, submitter, lane, status, kind"
        aria-label="Search submissions by title, submitter, lane, status or kind"
        autoComplete="off"
      />
      <Section
        title="Needs attention"
        items={attention}
        hit={hit}
        searching={searching}
        empty="Nothing is waiting on you."
      />
      <Section
        title="Everything else"
        items={rest}
        hit={hit}
        searching={searching}
        empty="Nothing else yet."
      />
    </div>
  );
}

function Section({
  title,
  items,
  hit,
  searching,
  empty,
}: {
  title: string;
  items: WorkSubmissionItem[];
  hit: (it: WorkSubmissionItem) => boolean;
  searching: boolean;
  /** Shown when the section has no rows at all (search or not). */
  empty: string;
}) {
  const shown = items.filter(hit).length;
  const count = searching
    ? `${shown} of ${items.length} match`
    : String(items.length);
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-bold">
        {title} ({count})
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-faint">{empty}</p>
      ) : shown === 0 ? (
        <p className="text-sm text-faint">No matches in this section.</p>
      ) : null}
      {items.length > 0 && (
        <div className="space-y-4">
          {items.map((it) => (
            <div key={it.id} hidden={!hit(it)}>
              {it.node}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
