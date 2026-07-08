import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { adminEmails } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import {
  listBrainSessions,
  getBrainSessionMessages,
  type SessionSummary,
} from "@/lib/brain-db";
import { fmtDate, requesterLabel } from "@/lib/admin/format";
import { ComposeForm } from "./compose-form";

export const dynamic = "force-dynamic";

interface ThreadTurn {
  key: string;
  role: "visitor" | "tron" | "admin";
  content: string;
  at: string;
  meta?: string;
}

// Email threads are the brain's "email…" sessions (one per sender+subject);
// manual admin sends recorded in admin_emails are merged into the thread by
// sessionId. Sends without a thread show in their own list.
export default async function AdminMailboxPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const auth = await getSession();
  if (!auth || !isAdmin(auth.email)) redirect("/login");

  const { session: selected } = await searchParams;

  let threads: SessionSummary[] = [];
  let brainError = false;
  try {
    threads = await listBrainSessions({ channel: "email", limit: 100 });
  } catch {
    brainError = true;
  }

  let manualSends: (typeof adminEmails.$inferSelect)[] = [];
  try {
    manualSends = await db
      .select()
      .from(adminEmails)
      .orderBy(desc(adminEmails.createdAt))
      .limit(50);
  } catch {
    // table appears with the next migration run
  }

  let turns: ThreadTurn[] = [];
  let replyTo = "";
  let replySubject = "";
  if (selected) {
    const thread = threads.find((t) => t.sessionId === selected);
    replyTo = thread?.requesterId ? requesterLabel(thread.requesterId) : "";
    // sessionId ends with the normalized subject slug: "email2-<sender>-<slug>"
    const slug = replyTo && selected.includes(replyTo)
      ? selected.slice(selected.indexOf(replyTo) + replyTo.length + 1)
      : "";
    if (slug && slug !== "no-subject") {
      replySubject = `Re: ${slug.replace(/-/g, " ")}`;
    }
    try {
      const [messages, threadSends] = await Promise.all([
        getBrainSessionMessages(selected),
        db
          .select()
          .from(adminEmails)
          .where(eq(adminEmails.sessionId, selected))
          .catch(() => [] as (typeof adminEmails.$inferSelect)[]),
      ]);
      turns = [
        ...messages.map((m): ThreadTurn => ({
          key: m.id,
          role: m.role === "user" ? "visitor" : "tron",
          content: m.content,
          at: m.createdAt,
        })),
        ...threadSends.map((s): ThreadTurn => ({
          key: `admin-${s.id}`,
          role: "admin",
          content: `${s.subject}\n\n${s.body}`,
          at: s.createdAt?.toISOString() ?? "",
          meta: `sent by ${s.sentBy}${s.success ? "" : " — FAILED"}`,
        })),
      ].sort((a, b) => a.at.localeCompare(b.at));
    } catch {
      brainError = true;
    }
  }

  const ROLE_STYLE: Record<ThreadTurn["role"], { label: string; color: string }> = {
    visitor: { label: "sender", color: "var(--xl-sand)" },
    tron: { label: "tron", color: "var(--xl-light-dim)" },
    admin: { label: "admin", color: "var(--xl-ok)" },
  };

  return (
    <div className="stack" style={{ gap: "var(--sp-6)" }}>
      <h1 className="text-2xl font-bold">Mailbox</h1>

      {brainError && (
        <p className="panel text-sm text-dim">
          Brain tables unavailable — is brain-api running against this database?
        </p>
      )}

      {selected ? (
        <>
          <section className="panel">
            <div className="row row--between flex-wrap mb-4">
              <div>
                <span className="sys-label">Thread</span>
                <div className="mono text-sm mt-1">{selected}</div>
              </div>
              <Link href="/admin/mailbox" className="btn btn--text">
                Back to inbox
              </Link>
            </div>
            <div className="stack" style={{ gap: "var(--sp-3)" }}>
              {turns.length === 0 && <p className="text-dim text-sm">No messages.</p>}
              {turns.map((t) => (
                <div key={t.key}>
                  <div className="text-xs text-faint mb-1">
                    <span style={{ color: ROLE_STYLE[t.role].color }}>
                      {ROLE_STYLE[t.role].label}
                    </span>{" "}
                    · {fmtDate(t.at)}
                    {t.meta ? ` · ${t.meta}` : ""}
                  </div>
                  <div
                    className="text-sm whitespace-pre-wrap"
                    style={{
                      borderLeft: `2px solid ${ROLE_STYLE[t.role].color}`,
                      paddingLeft: "var(--sp-3)",
                    }}
                  >
                    {t.content}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <ComposeForm defaultTo={replyTo} defaultSubject={replySubject} sessionId={selected} />
        </>
      ) : (
        <>
          <ComposeForm />

          <section>
            <h2 className="sys-label">Email threads</h2>
            <div className="panel mt-3 overflow-x-auto" style={{ padding: 0 }}>
              <table className="table w-full text-sm">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-left">Sender</th>
                    <th className="px-3 py-2 text-left">First message</th>
                    <th className="px-3 py-2 text-right">Msgs</th>
                    <th className="px-3 py-2 text-left">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {threads.length === 0 && !brainError && (
                    <tr>
                      <td className="px-3 py-3 text-dim" colSpan={4}>
                        No email conversations yet.
                      </td>
                    </tr>
                  )}
                  {threads.map((t) => (
                    <tr key={t.sessionId}>
                      <td className="px-3 py-2 mono text-xs whitespace-nowrap">
                        {t.requesterId ? requesterLabel(t.requesterId) : "unknown"}
                      </td>
                      <td className="px-3 py-2 max-w-md">
                        <Link
                          href={`/admin/mailbox?session=${encodeURIComponent(t.sessionId)}`}
                          className="no-underline"
                        >
                          <span className="line-clamp-2">{t.preview || t.sessionId}</span>
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right">{t.messageCount}</td>
                      <td className="px-3 py-2 text-dim whitespace-nowrap">{fmtDate(t.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="sys-label">Manual sends</h2>
            <div className="panel mt-3 overflow-x-auto" style={{ padding: 0 }}>
              <table className="table w-full text-sm">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-left">To</th>
                    <th className="px-3 py-2 text-left">Subject</th>
                    <th className="px-3 py-2 text-left">By</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {manualSends.length === 0 && (
                    <tr>
                      <td className="px-3 py-3 text-dim" colSpan={5}>
                        Nothing sent manually yet.
                      </td>
                    </tr>
                  )}
                  {manualSends.map((s) => (
                    <tr key={s.id}>
                      <td className="px-3 py-2 mono text-xs">{s.toEmail}</td>
                      <td className="px-3 py-2 max-w-sm truncate">{s.subject}</td>
                      <td className="px-3 py-2 text-dim">{s.sentBy}</td>
                      <td className="px-3 py-2">
                        <span className={s.success ? "badge badge--ok" : "badge badge--danger"}>
                          {s.success ? "sent" : "failed"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-dim whitespace-nowrap">
                        {fmtDate(s.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
