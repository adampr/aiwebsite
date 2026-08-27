// Roadmap step 04: Submit AI-Built Work (§5.18). Three zones: how work gets
// in (the SHARED /work submission dialog + the email lane, whose DKIM
// prerequisite is the DkimStep island inside the email panel), the viewer's
// own submissions in review (admins also see company submission METADATA,
// never held or failed content), and the company's published cards through
// the SAME card template as /work. Submitting is member-actionable; there
// is no admin gate on building things.
//
// checkDkim rides this page's Promise.all rather than roadmapStatus() (which
// would drag three unrelated queries in). It shares the module's in-memory
// per-process cache with the hub (10 minutes for a real verdict, 60s for a
// dns-error), so a hub visit warms this page and the second probe is usually
// free.

import type { Metadata } from "next";
import { readStaffPage, requireRoadmapPage } from "@/lib/roadmap/access";
import { STAFF_STEP_HREFS } from "@/lib/roadmap/config";
import { redirect } from "next/navigation";
import {
  companySubmissions,
  mySubmissions,
  publishedCards,
  type CompanySubmissionMeta,
  type PublishedCard,
} from "@/lib/work/db";
import { checkDkim } from "@/lib/roadmap/dkim";
import {
  EMAIL_PROMISE,
  WORK_STATUS_LABELS,
  type WorkStatus,
} from "@/lib/work/config";
import { CommunityCard } from "@/components/work-card";
import { DkimStep } from "@/components/roadmap/dkim-step";
import { EmailLink } from "@/components/email-link";
import { LocalTime } from "@/components/local-time";
import {
  RetrySubmission,
  RoadmapSubmitEntry,
  SubmissionProgress,
  TimeSavedEditor,
} from "./work-islands";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Submit AI-Built Work · Your AI Roadmap",
  robots: { index: false, follow: false },
};

const faint = { color: "var(--xl-text-faint)" } as const;

// ONE label map with /work/submit (WORK_STATUS_LABELS in work/config.ts), so
// the same row cannot read "Queued for review" here and "Waiting to start"
// there. The local map this replaces also had no `superseded` entry, which
// rendered the raw enum value.
function statusLabel(status: string): string {
  return WORK_STATUS_LABELS[status as WorkStatus] ?? status;
}

export default async function RoadmapWorkPage() {
  // Staff lane alias (§5.18 unification): staff submit on /work/submit.
  if (await readStaffPage()) redirect(STAFF_STEP_HREFS.work);
  const gate = await requireRoadmapPage("/roadmap/work");
  if (!gate.ok || !gate.principal.company) return null;
  const p = gate.principal;
  const company = gate.principal.company;
  const isAdmin = p.companyRole === "admin";

  const [mine, cards, dkim] = await Promise.all([
    mySubmissions(p.email),
    publishedCards({ companyId: company.id }),
    checkDkim(company.domain, { budgetMs: 800 }),
  ]);
  let companyMeta: CompanySubmissionMeta[] = [];
  if (isAdmin) {
    companyMeta = await companySubmissions(company.id);
  }
  const myIds = new Set(mine.map((r) => r.id));
  // Live progress on the THREE NEWEST active rows and no more. The cap is a
  // rate limiter, not a layout choice: work:poll allows 30 requests per 60 s
  // per user and each live tracker polls 6 times a minute, so a fourth would
  // put a reader's own page over the bucket it shares with every other tab
  // they have open. `mine` is newest first (mySubmissions orders by
  // created_at desc).
  const liveIds = new Set(
    mine
      .filter((r) => r.status === "received" || r.status === "running")
      .slice(0, 3)
      .map((r) => r.id)
  );

  return (
    <div className="space-y-14">
      <section>
        <span className="sys-label">Step 04 · Submit AI-Built Work</span>
        <h1 className="mt-4">Ship it, then show it</h1>
        <p className="mt-4 max-w-3xl text-sm">
          Built something with AI? Submit it and an automated editorial panel
          reviews it, drafts a card from your documents, and publishes only
          what it can verify to {company.name}&apos;s private page below.
        </p>
      </section>

      <section>
        <span className="sys-label">How Work Gets In</span>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div className="panel">
            <h2 className="text-lg">Submit it here</h2>
            <p className="mt-3 text-sm">
              Upload the package and the documents behind it; the panel takes
              it from there. {EMAIL_PROMISE}
            </p>
            <div className="mt-4">
              <RoadmapSubmitEntry orgName={company.name} />
            </div>
          </div>
          <div className="panel">
            <h2 className="text-lg">Email it to Tron</h2>
            <p className="mt-3 text-sm">
              Attach your package and mail it to{" "}
              <EmailLink email="Tron.Netter@ai.xl.net" className="mono" />.
              Send it from your {company.domain}{" "}
              address; that is how it reaches your company&apos;s roadmap.
            </p>
            <p className="mt-3 text-xs" style={faint}>
              This lane only: mail from {company.domain}{" "}
              has to be DKIM-signed, which is how we know a submission really
              came from your team. The form beside this one needs none of it.
            </p>
            <DkimStep initial={dkim} email={p.email} />
          </div>
        </div>
        <p className="mt-4 max-w-3xl text-xs" style={faint}>
          Published submissions are credited to your name and counted on your
          company&apos;s scorecard, which everyone at {company.domain} who
          signs in can see.
        </p>
      </section>

      <section>
        <span className="sys-label">In Review</span>
        {mine.length === 0 ? (
          <p className="mt-4 text-sm" style={faint}>
            You have not submitted anything yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {mine.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--xl-line)] pt-3 text-sm"
              >
                <span>{row.title}</span>
                <span className="badge">{statusLabel(row.status)}</span>
                {/* Owner directive 2026-08-25: the submitted-at reads in
                    the VIEWER's timezone, with a clock. These two rows were
                    the first of the class to move; on 2026-08-26 the owner
                    extended the ruling to EVERY stored timestamp a reader
                    sees, deadlines included, and fmtDate() lost its last
                    roadmap call site. Its header used to argue that
                    date-only precision made the zone question immaterial,
                    which was backwards - date-only is what makes it
                    material, because a wrong zone flips the whole token
                    instead of a suffix. <LocalTime> is the sanctioned way
                    across a server boundary: it server-renders the UTC
                    string (labelled "UTC"), so hydration matches byte for
                    byte, then swaps to the browser zone one tick after
                    mount. The swap is real and visible for that tick; it is
                    the price of an SSR'd row, which is why the client-only
                    list on /work/submit uses exact() instead. */}
                <span className="mono text-xs" style={faint}>
                  Submitted <LocalTime iso={row.createdAt.toISOString()} withTime />
                </span>
                {/* Queued rows get the manual lever too (the retry route
                    already authorizes company submitters on their own rows;
                    the missing button here made the queued email receipt's
                    Retry pointer false, design-panel finding 2026-08-05). */}
                {(row.status === "failed" || row.status === "received") && (
                  <RetrySubmission id={row.id} />
                )}
                {/* §5.16 time saved per month (owner ask 2026-08-27). Every
                    row in this list is the VIEWER's own (mySubmissions is
                    keyed on p.email), so the ownership question the
                    /work/submit list has to answer per row is already
                    settled here - the route re-checks it regardless.
                    Offered on every status, published included: this list is
                    where a company member comes back once the tool has been
                    in use for a month, which is the only point at which the
                    number is knowable. The admin "All {company} Submissions"
                    list below deliberately does NOT get it: that view is
                    titles, status and submitter only, and someone else's
                    self-reported estimate is not an admin's to edit.
                    The title rides along for the toggle's accessible name
                    only: five rows would otherwise give a screen reader five
                    buttons named "Edit", with nothing in the announcement to
                    say which submission each one belongs to. The status
                    rides along for one decision inside the island: a
                    superseded row shows its number read-only and offers no
                    control, because nothing reads it. That branch is
                    DEFENSIVE here rather than live: this list is not
                    status-filtered (mySubmissions selects every row the
                    person owns), but a company row can never BE superseded
                    (0035's work_sub_company_no_update_ck, plus the update
                    route and publishWithSupersede both refusing company
                    lanes). It earns its place by keeping the island honest
                    for the staff lane, where the same shared surface would
                    meet real superseded rows. */}
                <TimeSavedEditor
                  id={row.id}
                  title={row.title}
                  status={row.status}
                  minutes={row.timeSavedMinutes}
                />
                {/* basis-full: the <li> is a wrapping flex line of inline
                    metadata, and the tracker is a block that owns its own
                    row under it. Nothing else on this server-rendered page
                    auto-updates; these rows do. */}
                {liveIds.has(row.id) && (
                  <div className="basis-full">
                    <SubmissionProgress id={row.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {isAdmin && companyMeta.length > 0 && (
          <div className="mt-8">
            <span className="sys-label">All {company.name} Submissions</span>
            <p className="mt-2 text-xs" style={faint}>
              Admin view: titles, status, submission times, and submitter
              only. Held and failed content stays with its submitter.
            </p>
            <ul className="mt-3 space-y-3">
              {companyMeta.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--xl-line)] pt-3 text-sm"
                >
                  <span>{row.title}</span>
                  <span className="badge">{statusLabel(row.status)}</span>
                  <span className="mono text-xs" style={faint}>
                    {/* The middot suffix stays OUTSIDE <LocalTime>: that
                        component owns a <time dateTime> element, and folding
                        an email address into it would put non-time text
                        inside a machine-readable timestamp. The "Submitted"
                        label leads for the same reason it does on
                        /work/submit: the badge to its left can read
                        "Published", and a bare clock beside it reads as the
                        publish date. */}
                    Submitted <LocalTime iso={row.createdAt.toISOString()} withTime />
                    {myIds.has(row.id) ? " · you" : ` · ${row.submitterEmail}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="space-y-8">
        <div>
          <span className="sys-label">Published by {company.name}</span>
          {cards.length === 0 && (
            <p className="mt-4 text-sm" style={faint}>
              Nothing published yet. The first card that survives the panel
              lands here, and the scorecard goes live with it.
            </p>
          )}
        </div>
        {cards.map((item: PublishedCard, i: number) => (
          <CommunityCard
            key={item.id}
            item={item}
            index={i}
            defaultCredit={`the ${company.name} team`}
          />
        ))}
      </section>
    </div>
  );
}
