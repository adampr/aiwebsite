import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  users,
  smsConsentLogs,
  smsPromptEvents,
  phoneVerifications,
} from "@/lib/db/schema";
import { and, count, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { fmtDate } from "@/lib/admin/format";

export const dynamic = "force-dynamic";

// SMS opt-in operations view: prompt-card funnel health, the TCPA consent
// audit trail, and verification outcomes (abandonment / brute-force).
// Read-only by design — consent logs are append-only, and opt-outs live at
// the carrier (Twilio Advanced Opt-Out), not here.

type ConsentRow = {
  userId: string | null;
  email: string;
  phone: string;
  smsOptIn: boolean;
  consentText: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  pageUrl: string | null;
  createdAt: Date | null;
};

type VerificationRow = {
  id: number;
  userId: string;
  email: string | null;
  phone: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date | null;
};

// Honest outcome labeling: /api/texting/start retires superseded codes by
// setting consumed_at, so consumption alone does NOT mean verified — only a
// consent-log row from the same user+phone after the code was created does.
function verificationOutcome(
  v: VerificationRow,
  consents: ConsentRow[]
): { label: string; badge: string } {
  // The verify route sets consumed_at and inserts the consent row in the
  // same request, so a real verification's consent lands within moments of
  // consumption. Retired (superseded) codes have no such adjacent consent.
  const verified =
    v.consumedAt !== null &&
    consents.some(
      (c) =>
        c.userId === v.userId &&
        c.phone === v.phone &&
        c.smsOptIn &&
        c.createdAt &&
        v.consumedAt &&
        c.createdAt >= v.consumedAt &&
        c.createdAt.getTime() - v.consumedAt.getTime() < 120_000
    );
  if (verified) return { label: "VERIFIED", badge: "badge badge--ok" };
  if (v.attempts > 5) return { label: "BLOCKED", badge: "badge badge--danger" };
  if (v.consumedAt) return { label: "RETIRED", badge: "badge" };
  if (v.expiresAt.getTime() < Date.now()) return { label: "EXPIRED", badge: "badge" };
  return { label: "LIVE", badge: "badge" };
}

export default async function AdminTextingPage() {
  const session = await getSession();
  if (!session || !isAdmin(session.email)) redirect("/login");

  const since30d = new Date(Date.now() - 30 * 86_400_000);
  const stats = {
    verifiedNumbers: 0,
    dismissedUsers: 0,
    shownUsers30d: new Set<string>(),
    clickedUsers30d: new Set<string>(),
    snoozedUsers30d: new Set<string>(),
    consents30d: [] as Array<{ userId: string | null }>,
    recentConsents: [] as ConsentRow[],
    recentVerifications: [] as VerificationRow[],
  };

  // Every source degrades independently (console convention): a missing
  // table or empty result renders an empty state, never a 500.
  await Promise.all([
    (async () => {
      const [row] = await db
        .select({ count: count() })
        .from(users)
        .where(isNotNull(users.phoneVerifiedAt));
      stats.verifiedNumbers = row.count;
    })().catch(() => {}),
    (async () => {
      const [row] = await db
        .select({ count: count() })
        .from(users)
        .where(isNotNull(users.smsPromptDismissedAt));
      stats.dismissedUsers = row.count;
    })().catch(() => {}),
    (async () => {
      const rows = await db
        .select({ userId: smsPromptEvents.userId, event: smsPromptEvents.event })
        .from(smsPromptEvents)
        .where(gte(smsPromptEvents.createdAt, since30d));
      for (const r of rows) {
        if (r.event === "shown") stats.shownUsers30d.add(r.userId);
        else if (r.event === "clicked") stats.clickedUsers30d.add(r.userId);
        else if (r.event === "snoozed") stats.snoozedUsers30d.add(r.userId);
      }
    })().catch(() => {}),
    (async () => {
      stats.consents30d = await db
        .select({ userId: smsConsentLogs.userId })
        .from(smsConsentLogs)
        .where(
          and(
            eq(smsConsentLogs.smsOptIn, true),
            gte(smsConsentLogs.createdAt, since30d)
          )
        );
    })().catch(() => {}),
    (async () => {
      stats.recentConsents = await db
        .select()
        .from(smsConsentLogs)
        .orderBy(desc(smsConsentLogs.id))
        .limit(200);
    })().catch(() => {}),
    (async () => {
      stats.recentVerifications = await db
        .select({
          id: phoneVerifications.id,
          userId: phoneVerifications.userId,
          email: users.email,
          phone: phoneVerifications.phone,
          attempts: phoneVerifications.attempts,
          expiresAt: phoneVerifications.expiresAt,
          consumedAt: phoneVerifications.consumedAt,
          createdAt: phoneVerifications.createdAt,
        })
        .from(phoneVerifications)
        .leftJoin(users, eq(phoneVerifications.userId, users.id))
        .orderBy(desc(phoneVerifications.id))
        .limit(50);
    })().catch(() => {}),
  ]);

  const shown = stats.shownUsers30d.size;
  const clicked = stats.clickedUsers30d.size;
  // Population-consistent conversion: distinct opted-in users who were
  // actually shown the card in the window — NOT all-source opt-ins.
  const consentUsers30d = new Set(
    stats.consents30d.map((c) => c.userId).filter((id): id is string => !!id)
  );
  const promptVerified = [...consentUsers30d].filter((id) =>
    stats.shownUsers30d.has(id)
  ).length;
  const conversionPct = shown ? Math.round((promptVerified / shown) * 100) : 0;

  const funnel = [
    { stage: "Shown the card", n: shown },
    { stage: "Clicked through", n: clicked },
    { stage: "Verified a number", n: promptVerified },
  ];

  const displayConsents = stats.recentConsents.slice(0, 50);

  return (
    <div className="stack" style={{ gap: "var(--sp-8)" }}>
      <h1 className="text-2xl font-bold">Texting Opt-ins</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Verified numbers"
          value={String(stats.verifiedNumbers)}
          hint="all-time"
        />
        <StatCard
          label="Opt-ins · 30d"
          value={String(consentUsers30d.size)}
          hint="all sources"
        />
        <StatCard
          label="Prompt conversion · 30d"
          value={`${conversionPct}%`}
          hint={`${shown} shown → ${clicked} clicked → ${promptVerified} verified`}
        />
        <StatCard
          label="Don't ask again"
          value={String(stats.dismissedUsers)}
          hint={`all-time · ${stats.snoozedUsers30d.size} users snoozed 30d`}
        />
      </div>

      <section>
        <h2 className="sys-label">Prompt funnel · 30d · distinct users</h2>
        <div className="panel mt-3 overflow-x-auto" style={{ padding: 0 }}>
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left">Stage</th>
                <th className="px-3 py-2 text-right">Users</th>
                <th className="px-3 py-2 text-right">% of shown</th>
                <th className="px-3 py-2 text-left" style={{ width: "40%" }} />
              </tr>
            </thead>
            <tbody>
              {funnel.map((f) => {
                const pct = shown ? Math.round((f.n / shown) * 100) : 0;
                return (
                  <tr key={f.stage}>
                    <td className="px-3 py-2">{f.stage}</td>
                    <td className="px-3 py-2 text-right">{f.n}</td>
                    <td className="px-3 py-2 text-right text-dim">{pct}%</td>
                    <td className="px-3 py-2">
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "8px",
                          background: "var(--xl-light-dim)",
                          boxShadow: "0 0 8px var(--xl-light-glow)",
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-dim">
          &ldquo;Verified&rdquo; counts users who opted in after seeing the
          card in this window; the Opt-ins stat above counts all sources
          (including direct /texting visits).
        </p>
      </section>

      <section>
        <h2 className="sys-label">Recent opt-ins · consent audit trail</h2>
        <div className="panel mt-3 overflow-x-auto" style={{ padding: 0 }}>
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Phone</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left">IP</th>
                <th className="px-3 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody>
              {displayConsents.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-dim" colSpan={6}>
                    No opt-ins yet.
                  </td>
                </tr>
              )}
              {displayConsents.map((c, i) => (
                <tr key={i}>
                  <td className="px-3 py-2 text-dim whitespace-nowrap">
                    {fmtDate(c.createdAt)}
                  </td>
                  <td className="px-3 py-2">{c.email}</td>
                  <td className="px-3 py-2 mono text-xs">{c.phone}</td>
                  <td className="px-3 py-2">
                    <span className={c.smsOptIn ? "badge badge--ok" : "badge badge--danger"}>
                      {c.smsOptIn ? "OPT-IN" : "OPT-OUT"}
                    </span>
                  </td>
                  <td className="px-3 py-2 mono text-xs">{c.ipAddress ?? "—"}</td>
                  <td className="px-3 py-2">
                    <details>
                      <summary className="cursor-pointer text-xs text-dim">
                        consent record
                      </summary>
                      <div className="mt-2 max-w-md space-y-1 text-xs text-dim">
                        <p>{c.consentText ?? "—"}</p>
                        <p className="mono">{c.userAgent ?? "—"}</p>
                        <p className="mono">{c.pageUrl ?? "—"}</p>
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-dim">
          Opt-outs (STOP) are handled by Twilio Advanced Opt-Out at the
          carrier level, so no OPT-OUT rows appear here.
        </p>
      </section>

      <section>
        <h2 className="sys-label">Verification attempts · last 50</h2>
        <div className="panel mt-3 overflow-x-auto" style={{ padding: 0 }}>
          <table className="table w-full text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Phone</th>
                <th className="px-3 py-2 text-right">Attempts</th>
                <th className="px-3 py-2 text-left">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {stats.recentVerifications.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-dim" colSpan={5}>
                    No verification attempts yet.
                  </td>
                </tr>
              )}
              {stats.recentVerifications.map((v) => {
                const outcome = verificationOutcome(v, stats.recentConsents);
                return (
                  <tr key={v.id}>
                    <td className="px-3 py-2 text-dim whitespace-nowrap">
                      {fmtDate(v.createdAt)}
                    </td>
                    <td className="px-3 py-2">{v.email ?? "—"}</td>
                    <td className="px-3 py-2 mono text-xs">{v.phone}</td>
                    <td className="px-3 py-2 text-right">{v.attempts}</td>
                    <td className="px-3 py-2">
                      <span className={outcome.badge}>{outcome.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-dim">
          RETIRED = code superseded by a newer one or already used; BLOCKED =
          too many wrong codes; sustained BLOCKED rows from one number suggest
          abuse.
        </p>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="panel stat">
      <span className="sys-label">{label}</span>
      <span className="text-3xl font-bold glow">{value}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </div>
  );
}
