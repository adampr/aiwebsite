// /roadmap/approve-admin?req=<uuid> (§5.18): the landing page for the
// admin-access approval email. GET NEVER mutates (mail scanners prefetch
// links); the row is loaded in every branch and the request's company,
// requester, and even existence are disclosed ONLY to a viewer who passes
// the approver predicate - everyone else gets one identical generic screen,
// so a forwarded link is no oracle. Approval itself is the POST route, which
// re-derives the predicate server-side.
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { siteConfig } from "site.config";
import { emailDomain, isVerifiedStaffProvider } from "@/lib/rfp/access";
import { readRoadmapPrincipal } from "@/lib/roadmap/access";
import { adminRequestById, companyById } from "@/lib/roadmap/db";
import { LocalTime } from "@/components/local-time";
import { ApproveButton } from "./approve-button";

export const metadata: Metadata = {
  title: "Approve admin access",
  robots: { index: false, follow: false },
};

type Search = { searchParams: Promise<{ req?: string }> };

type RequestRow = NonNullable<Awaited<ReturnType<typeof adminRequestById>>>;

/** Module-scope so the render body stays pure (react-hooks/purity). */
function liveRequest(row: RequestRow | null): RequestRow | null {
  if (!row || row.status !== "pending") return null;
  return row.expiresAt.getTime() > Date.now() ? row : null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-lg space-y-6 pt-12">
      <span className="sys-label">AI Roadmap</span>
      <h1 className="text-2xl font-bold">Admin access approval</h1>
      {children}
    </div>
  );
}

const GENERIC = (
  <Shell>
    <p className="text-sm">
      This approval link is not valid for the account you are signed in as.
    </p>
    <p className="text-sm" style={{ color: "var(--xl-text-faint)" }}>
      Approvals need a signed-in approver: a current company admin for the
      workspace the request belongs to, or XL.net. If you administer a company
      here, make sure you are signed in with a verified method (Google or an
      email link), then open the link from the email again.
    </p>
  </Shell>
);

export default async function ApproveAdminPage({ searchParams }: Search) {
  const { req } = await searchParams;
  const requestId = typeof req === "string" ? req : "";
  const session = await readSession(siteConfig);
  if (!session)
    redirect(
      `/login?redirect=${encodeURIComponent(`/roadmap/approve-admin?req=${requestId}`)}`
    );

  // Load in EVERY branch (identical work for unknown/expired/foreign ids).
  const row = requestId ? await adminRequestById(requestId) : null;
  const live = liveRequest(row);

  // Approver predicates.
  const staffAdmin = isAdmin(session.email);
  const globalAdmin =
    staffAdmin &&
    isVerifiedStaffProvider(session) &&
    emailDomain(session.email) === "xl.net";
  let companyApprover = false;
  if (!globalAdmin && live) {
    const principal = await readRoadmapPrincipal();
    companyApprover =
      principal.ok &&
      principal.principal.companyRole === "admin" &&
      principal.principal.company?.id === live.companyId;
  }

  // A listed admin whose session is not verified staff gets the fix, not a
  // dead end (after parity: an xl.net Microsoft session without the mv
  // claim). This discloses nothing about the request (staff identity is the
  // viewer's own).
  if (staffAdmin && !globalAdmin && !companyApprover) {
    const back = `/roadmap/approve-admin?req=${encodeURIComponent(requestId)}`;
    return (
      <Shell>
        <p className="text-sm">
          Approvals need a verified staff sign-in for this account. Sign in
          again with Google or Microsoft and this page will show the request.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            className="btn no-underline"
            href={`/api/auth/google/start?redirect=${encodeURIComponent(back)}`}
          >
            Sign in with Google
          </a>
          <a
            className="btn no-underline"
            href={`/api/auth/microsoft/start?redirect=${encodeURIComponent(back)}`}
          >
            Sign in with Microsoft
          </a>
        </div>
      </Shell>
    );
  }

  if (!live || !(globalAdmin || companyApprover)) return GENERIC;

  const company = await companyById(live.companyId);
  return (
    <Shell>
      <div className="panel panel--raised space-y-4">
        <p className="text-sm">
          <span className="font-medium">{live.requesterEmail}</span> is asking
          to become a company admin for{" "}
          <span className="font-medium">{company?.name ?? "this company"}</span>
          {company ? ` (${company.domain})` : ""}.
        </p>
        {/* Owner directive 2026-08-25: both halves in the VIEWER's zone,
            and both at the SAME precision. This is a server component, so
            the two bare toLocaleDateString calls resolved to the VM's zone;
            and because expiresAt is createdAt + 7 days it carried the exact
            same wrong hour-of-day, so a request filed at 01:30 UTC read
            "Requested Aug 25 · expires Sep 1" to a Chicago approver whose
            civil dates were Aug 24 and Aug 31 - wrong in lockstep, which is
            also why converting only one half would have left the sentence
            disagreeing with itself. <LocalTime> rather than exact(): the
            page is server-rendered, and exact() formats in the runtime zone
            on first render, which here is still the VM. Date-only for both:
            expiresAt is enforced to the millisecond by liveRequest(), but
            this is prose furniture on a one-button page, a clock on one half
            of a 7-day window reads broken beside a bare date on the other,
            and no approver acts on the minute. OVERRULED 2026-08-26: the
            owner's ruling on this whole class is "clock on everything",
            deadlines explicitly included - an expiry date has to mean
            exactly what it says, and a reader who cannot see the hour
            cannot tell whether "expires Sep 1" leaves them a day or a
            minute. Both halves now carry withTime, still in lockstep, and
            the requester's mirror of this same sentence (RequestAdminAccess
            on the /roadmap hub, which was on the UTC fmtDate helper) moved
            with them, so the two sides of one row cannot disagree. The
            sentence stop stays OUTSIDE the second element - <LocalTime> owns
            a <time dateTime>, and a period is not part of a timestamp. */}
        <p className="text-sm" style={{ color: "var(--xl-text-faint)" }}>
          Requested <LocalTime iso={live.createdAt.toISOString()} withTime /> ·
          expires <LocalTime iso={live.expiresAt.toISOString()} withTime />.
          Any one recipient of the request email can approve it. Approving
          lets them manage the company directory, governance documents, and
          requests like this one.
        </p>
        <ApproveButton requestId={live.id} />
      </div>
    </Shell>
  );
}
