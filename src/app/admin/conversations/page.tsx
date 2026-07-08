import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import {
  listBrainSessions,
  getBrainSessionMessages,
  channelOfSession,
  type Channel,
  type SessionSummary,
  type BrainMessage,
} from "@/lib/brain-db";
import { fmtDate, requesterLabel } from "@/lib/admin/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const CHANNELS: Array<{ key: Channel | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "chat", label: "Web chat" },
  { key: "sms", label: "SMS" },
  { key: "email", label: "Email" },
];

// Read-only browser over every conversation the brain has held on the site's
// channels (brain_messages). Voice calls live on /admin/calls.
export default async function AdminConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; session?: string; offset?: string }>;
}) {
  const auth = await getSession();
  if (!auth || !isAdmin(auth.email)) redirect("/login");

  const params = await searchParams;
  const channel = (["chat", "sms", "email"] as const).find(
    (c) => c === params.channel
  );
  const offset = Math.max(0, Number(params.offset) || 0);
  const selected = params.session;

  let sessions: SessionSummary[] = [];
  let messages: BrainMessage[] = [];
  let dbError = false;
  try {
    [sessions, messages] = await Promise.all([
      listBrainSessions({ channel, limit: PAGE_SIZE, offset }),
      selected ? getBrainSessionMessages(selected) : Promise.resolve([]),
    ]);
  } catch {
    dbError = true;
  }

  const baseQs = channel ? `channel=${channel}&` : "";

  return (
    <div className="stack" style={{ gap: "var(--sp-6)" }}>
      <div className="row row--between flex-wrap">
        <h1 className="text-2xl font-bold">Conversations</h1>
        <div className="row" style={{ gap: "var(--sp-3)" }}>
          {CHANNELS.map((c) => {
            const active = (c.key === "all" && !channel) || c.key === channel;
            const href =
              c.key === "all" ? "/admin/conversations" : `/admin/conversations?channel=${c.key}`;
            return (
              <Link
                key={c.key}
                href={href}
                className={`badge no-underline ${active ? "badge--light" : ""}`}
              >
                {c.label}
              </Link>
            );
          })}
        </div>
      </div>

      {dbError && (
        <p className="panel text-sm text-dim">
          Brain tables unavailable — is brain-api running against this database?
        </p>
      )}

      {selected && (
        <section className="panel">
          <div className="row row--between flex-wrap mb-4">
            <div>
              <span className="sys-label">{channelOfSession(selected)} session</span>
              <div className="mono text-sm mt-1">{selected}</div>
            </div>
            <Link href={`/admin/conversations?${baseQs}offset=${offset}`} className="btn btn--text">
              Close
            </Link>
          </div>
          <div className="stack" style={{ gap: "var(--sp-3)" }}>
            {messages.length === 0 && <p className="text-dim text-sm">No messages.</p>}
            {messages.map((m) => (
              <div key={m.id}>
                <div className="text-xs text-faint mb-1">
                  <span className={m.role === "user" ? "text-sand" : "text-light"}>
                    {m.role === "user" ? "visitor" : m.role}
                  </span>{" "}
                  · {fmtDate(m.createdAt)}
                </div>
                <div
                  className="text-sm whitespace-pre-wrap"
                  style={{
                    borderLeft: `2px solid ${
                      m.role === "user" ? "var(--xl-sand)" : "var(--xl-light-dim)"
                    }`,
                    paddingLeft: "var(--sp-3)",
                  }}
                >
                  {m.content}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="panel overflow-x-auto" style={{ padding: 0 }}>
        <table className="table w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left">Channel</th>
              <th className="px-3 py-2 text-left">Who</th>
              <th className="px-3 py-2 text-left">First message</th>
              <th className="px-3 py-2 text-right">Msgs</th>
              <th className="px-3 py-2 text-left">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 && !dbError && (
              <tr>
                <td className="px-3 py-3 text-dim" colSpan={5}>
                  No conversations yet.
                </td>
              </tr>
            )}
            {sessions.map((s) => (
              <tr key={s.sessionId}>
                <td className="px-3 py-2">
                  <span className="badge">{channelOfSession(s.sessionId)}</span>
                </td>
                <td className="px-3 py-2 mono text-xs">
                  {s.requesterId ? requesterLabel(s.requesterId) : "anonymous"}
                </td>
                <td className="px-3 py-2 max-w-md">
                  <Link
                    href={`/admin/conversations?${baseQs}offset=${offset}&session=${encodeURIComponent(
                      s.sessionId
                    )}`}
                    className="no-underline"
                  >
                    <span className="line-clamp-2">{s.preview || s.sessionId}</span>
                  </Link>
                </td>
                <td className="px-3 py-2 text-right">{s.messageCount}</td>
                <td className="px-3 py-2 text-dim whitespace-nowrap">{fmtDate(s.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ gap: "var(--sp-3)" }}>
        {offset > 0 && (
          <Link
            href={`/admin/conversations?${baseQs}offset=${Math.max(0, offset - PAGE_SIZE)}`}
            className="btn"
          >
            ← Newer
          </Link>
        )}
        {sessions.length === PAGE_SIZE && (
          <Link
            href={`/admin/conversations?${baseQs}offset=${offset + PAGE_SIZE}`}
            className="btn"
          >
            Older →
          </Link>
        )}
      </div>
    </div>
  );
}
