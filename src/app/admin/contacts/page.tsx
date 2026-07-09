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
  // E.164 number the user proved possession of via /texting (§5.7). Set
  // only on email rows; its presence is what the "verified" badge means.
  verifiedPhone: string | null;
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
      verifiedPhone: null,
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

  // Kept outside the Promise.all closure: verified phones drive the
  // identity merge below, which must run after ALL sources have loaded.
  let userRows: Array<{ email: string; phone: string | null }> = [];

  await Promise.all([
    db
      .select()
      .from(users)
      .orderBy(desc(users.lastLoginAt))
      .limit(500)
      .then((rows) => {
        userRows = rows;
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

  // Identity merge: a phone verified via /texting is possession-proven
  // (double opt-in code), so the SMS/voice history keyed on that number IS
  // this user — fold the phone row into the email row. Runs after all
  // sources load; anonymous numbers with no matching user stay separate.
  // A user's firstSeen may predate their account (they texted Tron before
  // signing in) — that's correct, not a bug.
  for (const u of userRows) {
    if (!u.phone) continue;
    const emailRow = contacts.get(u.email.toLowerCase());
    if (!emailRow) continue;
    emailRow.verifiedPhone = u.phone;
    const phoneRow = contacts.get(u.phone.toLowerCase());
    if (phoneRow && phoneRow !== emailRow) {
      for (const ch of phoneRow.channels) emailRow.channels.add(ch);
      emailRow.interactions += phoneRow.interactions;
      if (phoneRow.firstSeen && (!emailRow.firstSeen || phoneRow.firstSeen < emailRow.firstSeen)) {
        emailRow.firstSeen = phoneRow.firstSeen;
      }
      if (phoneRow.lastSeen && (!emailRow.lastSeen || phoneRow.lastSeen > emailRow.lastSeen)) {
        emailRow.lastSeen = phoneRow.lastSeen;
      }
      contacts.delete(u.phone.toLowerCase());
    }
  }

  const list = [...contacts.values()].sort((a, b) =>
    (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "")
  );
  const verifiedCount = list.filter((c) => c.verifiedPhone).length;

  return (
    <div className="stack" style={{ gap: "var(--sp-6)" }}>
      <div className="row row--between flex-wrap">
        <h1 className="text-2xl font-bold">Contacts</h1>
        <span className="text-sm text-dim">
          {list.length} people across all channels · {verifiedCount} verified{" "}
          {verifiedCount === 1 ? "number" : "numbers"}
        </span>
      </div>

      <div className="panel overflow-x-auto" style={{ padding: 0 }}>
        <table className="table w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left">Contact</th>
              <th className="px-3 py-2 text-left">Phone</th>
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
                <td className="px-3 py-3 text-dim" colSpan={7}>
                  No contacts yet.
                </td>
              </tr>
            )}
            {list.map((c) => (
              <tr key={c.identifier}>
                <td className="px-3 py-2 mono text-xs">{c.identifier}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {c.verifiedPhone ? (
                    <>
                      <span className="mono text-xs">{c.verifiedPhone}</span>{" "}
                      <span className="badge badge--ok">verified</span>
                    </>
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                </td>
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
