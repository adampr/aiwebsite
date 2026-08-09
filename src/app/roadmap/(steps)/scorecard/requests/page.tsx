// Scorecard click-through (§5.19): the work behind one scorecard cell -
// /roadmap/scorecard/requests?person=<email>&col=requested|working|completed
// - for BOTH lanes (staff via readStaffPage -> internal scope; company via
// the trusted principal). person/col are pure filters INSIDE the session's
// own lane (a foreign email yields an empty list, never an oracle) and the
// list shares its status sets with the scorecard counts, so the clickable
// number and this page can never disagree (modulo the disclosed 200 cap).

import type { Metadata } from "next";
import Link from "next/link";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import {
  formatValueUsd,
  REQUEST_CAPS,
  REQUEST_STATUS_COPY,
  type WorkRequestStatus,
} from "@/lib/work/requests-config";
import { scorecardRequestList } from "@/lib/work/requests-db";
import type { WorkScope } from "@/lib/work/scope";
import { fmtDate } from "@/components/roadmap/dates";
import { personLabel } from "@/lib/person-label";
import {
  RequestsListClient,
  type ListRowData,
} from "./requests-list-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Employee Scorecard · Requested Work",
  robots: { index: false, follow: false },
};

const faint = { color: "var(--xl-text-faint)" } as const;

const COLS = {
  requested: {
    heading: "Requested work",
    dateHeading: "Approved",
    empty:
      "No approved requests from this person yet. Requests appear here once an administrator approves them for the list.",
  },
  working: {
    heading: "Working on",
    dateHeading: "Claimed",
    empty: "This person is not working on any requested projects right now.",
  },
  completed: {
    heading: "Completed work",
    dateHeading: "Completed",
    empty:
      "No validated completions for this person yet. Projects appear here after an administrator validates them.",
  },
} as const;
type Col = keyof typeof COLS;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Search = { searchParams: Promise<{ person?: string; col?: string }> };

export default async function ScorecardRequestsPage({ searchParams }: Search) {
  let scope: WorkScope | null = null;
  const staff = await readStaffPage();
  if (staff) {
    scope = { companyId: null };
  } else {
    const gate = await requireRoadmapPage("/roadmap/scorecard");
    if (!gate.ok || !gate.principal.company) return null;
    scope = { companyId: gate.principal.company.id };
  }

  const params = await searchParams;
  // Object.hasOwn, not `in`: the `in` operator walks the prototype chain,
  // so ?col=toString would bypass the fallback (refuter finding).
  const col: Col =
    params.col && Object.hasOwn(COLS, params.col)
      ? (params.col as Col)
      : "requested";
  const rawPerson = (params.person ?? "").trim().toLowerCase();
  const person =
    rawPerson.length <= 254 && EMAIL_RE.test(rawPerson) ? rawPerson : null;

  const rows = person ? await scorecardRequestList(scope, person, col) : [];
  const dateOf = (r: (typeof rows)[number]) =>
    col === "requested"
      ? r.approvedAt
      : col === "working"
        ? r.claimedAt
        : r.completedAt;
  const data: ListRowData[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    statusLabel:
      REQUEST_STATUS_COPY[r.status as WorkRequestStatus] ?? r.status,
    valueLabel: formatValueUsd(r.valueUsd),
    byLabel: personLabel(r.requesterName, r.requesterEmail),
    dateLabel: fmtDate(dateOf(r)) || "·",
  }));

  return (
    <div className="space-y-10">
      <section>
        <span className="sys-label">Step 07 · Employee Scorecard</span>
        <h1 className="mt-4">{COLS[col].heading}</h1>
        {person && (
          <p className="mono mt-3 text-xs" style={faint}>
            {person}
          </p>
        )}
        <p className="mt-4 text-sm">
          <Link href="/roadmap/scorecard">Back to the scorecard</Link>
        </p>
      </section>

      <section className="panel">
        {data.length === 0 ? (
          <p className="text-sm" style={faint}>
            {COLS[col].empty}
          </p>
        ) : (
          <RequestsListClient
            rows={data}
            dateHeading={COLS[col].dateHeading}
            capNote={
              rows.length >= REQUEST_CAPS.listMax
                ? `Showing the most recent ${REQUEST_CAPS.listMax}.`
                : null
            }
          />
        )}
      </section>
    </div>
  );
}
