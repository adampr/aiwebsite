import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { listBrainRequesters, listPhoneCalls } from "@/lib/brain-db";
import { fmtDate } from "@/lib/admin/format";

export const dynamic = "force-dynamic";

interface Contact {
  identifier: string; // email address or phone number
  channels: Set<string>;
  displayName: string | null;
  interactions: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

// There is no contacts table: this directory is derived on the fly from
// everyone who has touched a channel — OAuth sign-ins (users), SMS/email
// requesters (brain_messages), and phone calls (brain_phone_calls).
export default async function AdminContactsPage() {
  const session = await getSession();
  if (!session || !isAdmin(session.email)) redirect("/login");

  const contacts = new Map<string, Contact>();
  const touch = (
    identifier: string,
    channel: string,
    at: string | null,
    interactions = 1,
    displayName: string | null = null
  ) => {
    const key = identifier.toLowerCase();
    const existing = contacts.get(key) ?? {
      identifier,
      channels: new Set<string>(),
      displayName: null,
      interactions: 0,
      firstSeen: null,
      lastSeen: null,
    };
    existing.channels.add(channel);
    existing.interactions += interactions;
    if (displayName) existing.displayName = displayName;
    if (at) {
      if (!existing.firstSeen || at < existing.firstSeen) existing.firstSeen = at;
      if (!existing.lastSeen || at > existing.lastSeen) existing.lastSeen = at;
    }
    contacts.set(key, existing);
  };

  await Promise.all([
    db
      .select()
      .from(users)
      .orderBy(desc(users.lastLoginAt))
      .limit(500)
      .then((rows) => {
        for (const u of rows) {
          touch(u.email, "login", u.createdAt?.toISOString() ?? null, 1, u.displayName);
          if (u.lastLoginAt) touch(u.email, "login", u.lastLoginAt.toISOString(), 0);
        }
      })
      .catch(() => {}),
    listBrainRequesters()
      .then((rows) => {
        for (const r of rows) {
          const isEmail = r.requesterId.startsWith("email:");
          const id = r.requesterId.replace(/^email:/, "");
          touch(id, isEmail ? "email" : "sms", r.firstAt, r.messageCount);
          touch(id, isEmail ? "email" : "sms", r.lastAt, 0);
        }
      })
      .catch(() => {}),
    listPhoneCalls(200)
      .then((calls) => {
        for (const c of calls) {
          const number = c.direction === "inbound" ? c.fromNumber : c.toNumber;
          if (number) touch(number, "voice", c.startedAt, 1);
        }
      })
      .catch(() => {}),
  ]);

  const list = [...contacts.values()].sort((a, b) =>
    (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "")
  );

  return (
    <div className="stack" style={{ gap: "var(--sp-6)" }}>
      <div className="row row--between flex-wrap">
        <h1 className="text-2xl font-bold">Contacts</h1>
        <span className="text-sm text-dim">{list.length} people across all channels</span>
      </div>

      <div className="panel overflow-x-auto" style={{ padding: 0 }}>
        <table className="table w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left">Contact</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">Channels</th>
              <th className="px-3 py-2 text-right">Interactions</th>
              <th className="px-3 py-2 text-left">First seen</th>
              <th className="px-3 py-2 text-left">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-dim" colSpan={6}>
                  No contacts yet.
                </td>
              </tr>
            )}
            {list.map((c) => (
              <tr key={c.identifier}>
                <td className="px-3 py-2 mono text-xs">{c.identifier}</td>
                <td className="px-3 py-2">{c.displayName ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className="row" style={{ gap: "var(--sp-2)" }}>
                    {[...c.channels].map((ch) => (
                      <span key={ch} className="badge">
                        {ch}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">{c.interactions}</td>
                <td className="px-3 py-2 text-dim whitespace-nowrap">{fmtDate(c.firstSeen)}</td>
                <td className="px-3 py-2 text-dim whitespace-nowrap">{fmtDate(c.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
