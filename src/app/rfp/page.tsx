// /rfp overview (§5.17). Server-rendered; the layout has already gated, and
// this page re-reads the gate itself because a layout is not an authorization
// boundary for anything but the initial render.

import Link from "next/link";
import { requireRfpPage } from "@/lib/rfp/access";
import {
  currentKbVersion,
  currentRateCard,
  factCounts,
  intakeQuestions,
  usd,
} from "@/lib/rfp/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function RfpOverviewPage() {
  const gate = await requireRfpPage("/rfp");
  if (!gate.ok) return null; // the layout renders the denial

  let kb: number;
  let counts: Awaited<ReturnType<typeof factCounts>>;
  let card: Awaited<ReturnType<typeof currentRateCard>>;
  let questions: Awaited<ReturnType<typeof intakeQuestions>>;
  try {
    [kb, counts, card, questions] = await Promise.all([
      currentKbVersion(),
      factCounts(),
      currentRateCard(),
      intakeQuestions(),
    ]);
  } catch {
    // Three states that must never look alike: no data, feature off, and
    // source unavailable. This is the third.
    return (
      <div className="panel panel--raised">
        <p>
          The knowledge base did not answer. Nothing has been changed. Reload
          the page, and if it keeps failing the database is the place to look.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div>
        <span className="sys-label">Overview</span>
        <p className="mt-4 max-w-2xl">
          Give it an RFP and it drafts the response: every section against the
          structured knowledge base below, pricing computed from the rate card
          in force, the questions it cannot answer asked one at a time, and
          the finished document exported to Word or PDF once the compliance
          checks pass. Facts a proposal may assert live here; a draft never
          invents one.
        </p>
      </div>

      <div className="grid grid--4">
        <div className="stat">
          <span className="stat-value">{counts.live}</span>
          <span className="stat-label">Live facts</span>
        </div>
        <div className="stat">
          <span className="stat-value">{counts.negative}</span>
          <span className="stat-label">Negative facts</span>
        </div>
        <div className="stat">
          <span className="stat-value">{counts.corrected}</span>
          <span className="stat-label">Corrected</span>
        </div>
        <div className="stat">
          <span className="stat-value">v{kb}</span>
          <span className="stat-label">KB version</span>
        </div>
      </div>

      <div className="panel">
        <span className="sys-label">Where it stands</span>
        <ul className="mt-4 space-y-3 text-sm">
          <li>
            <strong>
              {counts.live} fact{counts.live === 1 ? " is" : "s are"}
            </strong>{" "}
            live, of which <strong>{counts.negative}</strong>{" "}
            {counts.negative === 1 ? "is" : "are"} negative. A negative fact
            is a record, not an absence: it is what stops a draft inventing a
            capability because nothing said otherwise.
          </li>
          <li>
            <strong>
              {counts.corrected} fact{counts.corrected === 1 ? " has" : "s have"}
            </strong>{" "}
            been corrected since the corpus was first written. The wrong
            versions are retired rather than deleted, so a proposal that cited
            one stays resolvable.
          </li>
          {counts.unconfirmed > 0 && (
            <li>
              <strong>{counts.unconfirmed}</strong>{" "}
              {counts.unconfirmed === 1 ? "is" : "are"} marked as needing
              confirmation. Usable in a draft, and flagged until confirmed.
            </li>
          )}
          <li>
            {card ? (
              <>
                The rate card in force carries{" "}
                <strong>{card.items.length} line items</strong>, a{" "}
                {card.minimumFullyManagedUsers}
                -user minimum, and a floor of{" "}
                <strong>{usd(card.minimumMonthlyFeeCents)}</strong> per month.
              </>
            ) : (
              <>
                No rate card is loaded. Pricing cannot be computed until one
                is.
              </>
            )}
          </li>
          <li>
            <strong>{questions.length} intake questions</strong> are on file,
            covering what a proposal cannot answer from the knowledge base
            alone.
          </li>
        </ul>
        <p className="mt-6 flex flex-wrap gap-3">
          <Link href="/rfp/new" className="btn btn--primary">
            Start an RFP
          </Link>
          <Link href="/rfp/list" className="btn btn--text">
            Your RFPs
          </Link>
          <Link href="/rfp/knowledge" className="btn btn--text">
            Knowledge base
          </Link>
        </p>
      </div>

    </div>
  );
}
