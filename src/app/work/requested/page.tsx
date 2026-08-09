// /work/requested (§5.19): the internal Requested Work board for xl.net
// staff. Request development projects (title, description, estimated annual
// value, metric lines), see your own requests in every status, and the
// board of approved projects anyone can claim (max 3 at a time), mark
// complete, and have an admin validate. /work/submit page conventions:
// session gate with deep-link redirect, instructive notices instead of
// bounces, noindexed and absent from the sitemap.
//
// The internal lane is pinned to the /rfp provider anchor (Google, or
// Microsoft carrying the per-login mv claim): an mv-less Microsoft
// common-tenant session can claim any @xl.net address (nOAuth,
// src/lib/work/http.ts header), and here that would burn claim slots and
// flood the admin queue. requireRequestUser enforces the same rule on every
// route; this page just explains it.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { siteConfig } from "site.config";
import { emailDomain, isVerifiedStaffProvider } from "@/lib/rfp/access";
import { verifiedWebAdmin, WORK_SUBMIT_DOMAINS } from "@/lib/work/http";
import { INTERNAL_SCOPE } from "@/lib/work/scope";
import { REQUEST_CAPS } from "@/lib/work/requests-config";
import {
  boardList,
  developerActiveCount,
  mineList,
  pendingQueue,
  requesterOpenCount,
} from "@/lib/work/requests-db";
import { RequestForm } from "@/components/requests/request-form";
import { RequestBoard } from "@/components/requests/request-board";
import { MyRequests } from "@/components/requests/my-requests";
import { PendingQueue } from "@/components/requests/pending-queue";
import {
  toBoardRow,
  toMineRow,
  toQueueRow,
} from "@/components/requests/serialize";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Requested Work",
  robots: { index: false, follow: false },
};

export default async function WorkRequestedPage() {
  const session = await readSession(siteConfig);
  if (!session)
    redirect(`/login?redirect=${encodeURIComponent("/work/requested")}`);
  const domain = emailDomain(session.email) ?? "";
  const staff = WORK_SUBMIT_DOMAINS.includes(domain);

  if (!staff) {
    return (
      <div className="mx-auto max-w-2xl space-y-8 pt-12">
        <div className="text-center">
          <span className="sys-label sys-label--center">
            Our Work / Requested Work
          </span>
          <h1 className="mt-8">Requested work</h1>
        </div>
        <div className="panel panel--raised">
          <p className="text-sm">
            This board is for XL.net staff accounts. You are signed in as{" "}
            {session.email}. If your company is on the AI Roadmap, your own
            requested-work board lives on{" "}
            <Link href="/roadmap/request">your roadmap</Link>.
          </p>
        </div>
      </div>
    );
  }

  if (!isVerifiedStaffProvider(session)) {
    return (
      <div className="mx-auto max-w-2xl space-y-8 pt-12">
        <div className="text-center">
          <span className="sys-label sys-label--center">
            Our Work / Requested Work
          </span>
          <h1 className="mt-8">Requested work</h1>
        </div>
        <div className="panel panel--raised">
          <p className="text-sm">
            The requested-work board needs a verified xl.net sign-in. You
            are signed in as {session.email} via {session.provider}, but this
            session could not verify your address. Sign in again with your
            xl.net Google or Microsoft account and come back.
          </p>
        </div>
      </div>
    );
  }

  const email = session.email.toLowerCase();
  const user = {
    userId: session.userId,
    email: session.email,
    emailDomain: domain,
    provider: session.provider,
    mv: session.mv === true,
    admin: isAdmin(session.email),
  };
  const admin = verifiedWebAdmin(user);

  const [board, mine, openCount, activeClaims, queue] = await Promise.all([
    boardList(INTERNAL_SCOPE),
    mineList(INTERNAL_SCOPE, email),
    requesterOpenCount(INTERNAL_SCOPE, email),
    developerActiveCount(INTERNAL_SCOPE, email),
    admin ? pendingQueue(INTERNAL_SCOPE) : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-8 pt-12">
      <div className="text-center">
        <span className="sys-label sys-label--center">
          Our Work / Requested Work
        </span>
        <h1 className="mt-8">Request AI-built work</h1>
        <p className="mx-auto mt-6 text-sm">
          Ask for a development project worth building: describe it, put an
          estimated annual value in dollars on it, and list the metrics
          behind that number. An admin approves each request onto the board;
          anyone here can take on up to{" "}
          {REQUEST_CAPS.concurrentPerDeveloper} projects at a time, and an
          admin validates every completion.
        </p>
      </div>

      <div className="panel panel--raised">
        <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
          Request a project
        </h2>
        <div className="mt-4">
          <RequestForm openCount={openCount} />
        </div>
      </div>

      {admin && (
        <div className="panel space-y-4">
          <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
            Awaiting approval
          </h2>
          <PendingQueue rows={queue.map(toQueueRow)} />
        </div>
      )}

      <div className="panel space-y-4">
        <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
          Your requests
        </h2>
        <MyRequests
          rows={mine.map(toMineRow)}
          capped={mine.length >= REQUEST_CAPS.listMax}
        />
      </div>

      <div className="panel space-y-4">
        <h2 className="mono text-xs uppercase tracking-[0.2em] text-light">
          The board
        </h2>
        <RequestBoard
          rows={board.map(toBoardRow)}
          viewerEmail={email}
          isAdmin={admin}
          activeClaims={activeClaims}
          capped={board.length >= REQUEST_CAPS.listMax}
        />
      </div>
    </div>
  );
}
