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
          The structured knowledge base behind XL.net proposal writing: the
          facts a proposal may assert, the rate card its pricing must come
          from, and the intake questions that fill the gaps. Nothing here is
          sent anywhere. It is the source the drafting work reads from.
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
            <strong>{counts.live} facts</strong> are live, of which{" "}
            <strong>{counts.negative}</strong>{" "}
            are negative. A negative fact is a record, not an absence: it is
            what stops a draft inventing a capability because nothing said
            otherwise.
          </li>
          <li>
            <strong>{counts.corrected} facts</strong> have been corrected since
            the corpus was first written. The wrong versions are retired rather
            than deleted, so a proposal that cited one stays resolvable.
          </li>
          {counts.unconfirmed > 0 && (
            <li>
              <strong>{counts.unconfirmed}</strong>{" "}
              are marked as needing confirmation. They are usable in a draft
              and they surface as open questions.
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
        <p className="mt-6">
          <Link href="/rfp/knowledge" className="btn btn--primary">
            Open the knowledge base
          </Link>
        </p>
      </div>

      <div className="panel">
        <span className="sys-label">Not here yet</span>
        <p className="mt-4 text-sm">
          Uploading an RFP, drafting against it, the compliance gate, and
          export to Word and PDF are built and tested, and are not wired into
          this section yet. They arrive with the review screen. What is here is
          the knowledge base those steps read from.
        </p>
      </div>
    </div>
  );
}
