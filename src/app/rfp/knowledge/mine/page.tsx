// /rfp/knowledge/mine — knowledge you added (§5.17, editable per §5.17.9).
//
// Private rows are usable in YOUR drafts and nobody else's. They become
// shared only when an XL.net admin approves them (or, for an admin's own
// row, promotes it from here), which mints a brand new fact rather than
// flipping a flag on this row. Everything not yet in the shared base can be
// edited in place, sent, withdrawn or deleted from this page.

import type { Metadata } from "next";
import { requireRfpPage } from "@/lib/rfp/access";
import { KnowledgeNav } from "../nav";
import { allFacts, listMyKnowledge, type FactRow } from "@/lib/rfp/db";
import { AddKnowledge } from "./add";
import { KnowledgeRow, type MineRow } from "./row";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Your knowledge",
  robots: { index: false, follow: false },
};

/**
 * Follow a minted fact forward through corrections (each correction inserts
 * a new row whose `supersedes` points at the old one) to where it stands
 * today. The proposal row remembers only the FIRST id it minted.
 */
function currentVersion(
  factId: string,
  byId: Map<string, FactRow>,
  successorOf: Map<string, FactRow>
): FactRow | null {
  let f = byId.get(factId) ?? null;
  const seen = new Set<string>();
  while (f && f.retiredInKb !== null && !seen.has(f.id)) {
    seen.add(f.id);
    const next = successorOf.get(f.id);
    if (!next) break;
    f = next;
  }
  return f;
}

export default async function MyKnowledgePage() {
  const gate = await requireRfpPage("/rfp/knowledge/mine");
  if (!gate.ok) return null;

  const [rows, facts] = await Promise.all([
    listMyKnowledge(gate.user),
    allFacts(),
  ]);

  const byId = new Map(facts.map((f) => [f.id, f]));
  const successorOf = new Map<string, FactRow>();
  const liveByKey = new Map<string, FactRow>();
  for (const f of facts) {
    if (f.supersedes) successorOf.set(f.supersedes, f);
    if (f.retiredInKb === null) liveByKey.set(f.key, f);
  }

  const items: MineRow[] = rows.map((r) => {
    const promoted = r.promotedFactId
      ? currentVersion(r.promotedFactId, byId, successorOf)
      : null;
    const live = r.factKey ? (liveByKey.get(r.factKey) ?? null) : null;
    return {
      id: r.id,
      status: r.status,
      kind: r.kind,
      factKey: r.factKey,
      category: r.category,
      statement: r.statement,
      detail: r.detail,
      polarity: r.polarity,
      // Raw instant; the island formats it (server pages cannot, see the
      // review page's note and lib/rfp/time.ts).
      createdAt: r.createdAt.toISOString(),
      reviewedBy: r.reviewedBy,
      reviewNote: r.reviewNote,
      conflict:
        r.status !== "approved" && live ? live.statement : null,
      promoted: promoted
        ? {
            id: promoted.id,
            live: promoted.retiredInKb === null,
            statement: promoted.statement,
            detail: promoted.detail,
            polarity: promoted.polarity,
            category: promoted.category,
          }
        : null,
    };
  });

  return (
    <div className="space-y-10">
      <KnowledgeNav admin={gate.user.admin} />
      <div>
        <span className="sys-label">Your knowledge</span>
        <p className="mt-4 max-w-2xl">
          Anything you add here is usable in your own drafts straight away, and
          in nobody else&apos;s. Change it, send it for approval, or take it
          back at any time. An XL.net admin decides whether a fact joins the
          shared base that everyone drafts from
          {gate.user.admin ? ", and you can add yours straight in" : ""}.
        </p>
      </div>

      <AddKnowledge />

      {items.length === 0 ? (
        <div className="panel">
          <p className="text-faint">You have not added anything yet.</p>
        </div>
      ) : (
        <div className="panel">
          {items.map((it, i) => (
            <div className={i > 0 ? "rfp-row" : undefined} key={it.id}>
              <KnowledgeRow row={it} admin={gate.user.admin} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
