// /rfp/knowledge/review — the admin approval queue (§5.17).
//
// Approving mints a NEW fact at a new knowledge-base version. It never edits
// an existing row, so an approved fact's id has never been anything else and
// every stored citation stays resolvable.

import type { Metadata } from "next";
import { requireRfpPage } from "@/lib/rfp/access";
import { KnowledgeNav } from "../nav";
import { liveFacts, listPendingKnowledge } from "@/lib/rfp/db";
import { ReviewQueue } from "./queue";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Review queue",
  robots: { index: false, follow: false },
};

export default async function ReviewPage() {
  const gate = await requireRfpPage("/rfp/knowledge/review");
  if (!gate.ok) return null;

  if (!gate.user.admin) {
    return (
      <div className="panel panel--raised">
        <p>
          Approving knowledge is an XL.net admin job. You can propose facts
          from your own knowledge page, and they land here for a decision.
        </p>
      </div>
    );
  }

  const [pending, facts] = await Promise.all([
    listPendingKnowledge(gate.user),
    liveFacts(),
  ]);

  // The conflict check is what makes a decision fast: most submissions are
  // restatements of something already on file, and the right answer is
  // usually "merge", not "add".
  const byKey = new Map(facts.map((f) => [f.key, f]));

  return (
    <div className="space-y-8">
      <KnowledgeNav admin={gate.user.admin} />
      <div>
        <span className="sys-label">Review queue</span>
        <p className="mt-4 max-w-2xl">
          Facts staff have proposed for the shared base. Approving one puts it
          in front of every future proposal, so the conflict check below is
          worth reading before you decide.
        </p>
      </div>

      {pending.length === 0 ? (
        <div className="panel">
          <p className="text-faint">Nothing is waiting.</p>
        </div>
      ) : (
        <ReviewQueue
          items={pending.map((p) => ({
            id: p.id,
            statement: p.statement,
            detail: p.detail,
            factKey: p.factKey,
            polarity: p.polarity,
            category: p.category,
            owner: p.ownerEmail,
            // Owner directive 2026-08-26, closing the KNOWN GAP a6b52ef
            // recorded. This page is an async SERVER component, and when()
            // is doubly wrong here: past 7 days it falls through to an
            // unpinned Intl.DateTimeFormat, which on the VM is UTC wearing
            // no label (the rule lib/rfp/time.ts states in its own header),
            // and under 7 days it closes over Date.now() at REQUEST time, so
            // "3 hours ago" freezes into the HTML and ages silently on an
            // open queue. The instant crosses raw and the island renders it
            // with <When>, which re-runs the same formatter after mount.
            // <When> rather than <LocalTime> because relative-then-absolute
            // is the point on a review queue: how long a proposal has been
            // waiting is the fact an approver is actually reading.
            createdAt: p.createdAt.toISOString(),
            conflict: p.factKey
              ? (byKey.get(p.factKey)?.statement ?? null)
              : null,
          }))}
        />
      )}
    </div>
  );
}
