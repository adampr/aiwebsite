import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import { MessagesClient } from "./messages-client";

export const dynamic = "force-dynamic";

export default async function AdminMessagesPage() {
  const session = await getSession();
  if (!session || !isAdmin(session.email)) redirect("/login");

  return (
    <div className="stack" style={{ gap: "var(--sp-6)" }}>
      <h1 className="text-2xl font-bold">SMS Messages</h1>
      <MessagesClient />
    </div>
  );
}
