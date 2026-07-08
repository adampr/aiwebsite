import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import {
  listBrainMemories,
  getBrainMemoryStats,
  type MemoryRow,
  type MemoryStat,
} from "@/lib/brain-db";
import { fmtDate, fmtBytes } from "@/lib/admin/format";
import { RefreshButton } from "./refresh-button";

export const dynamic = "force-dynamic";

// What Tron knows: the 7 seed identity rows (deploy/seed-tron-memories.sql)
// plus one source_type='site_crawl' row per crawled page. Size matters —
// every public row is injected into voice sessions — so bytes are shown.
export default async function AdminKnowledgePage() {
  const session = await getSession();
  if (!session || !isAdmin(session.email)) redirect("/login");

  let memories: MemoryRow[] = [];
  let memoryStats: MemoryStat[] = [];
  let dbError = false;
  try {
    [memories, memoryStats] = await Promise.all([
      listBrainMemories(300),
      getBrainMemoryStats(),
    ]);
  } catch {
    dbError = true;
  }

  const totalBytes = memoryStats.reduce((sum, s) => sum + s.totalBytes, 0);

  return (
    <div className="stack" style={{ gap: "var(--sp-6)" }}>
      <div className="row row--between flex-wrap">
        <h1 className="text-2xl font-bold">Knowledge</h1>
        <RefreshButton />
      </div>

      {dbError && (
        <p className="panel text-sm text-dim">
          Brain tables unavailable — is brain-api running against this database?
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {memoryStats.map((s) => (
          <div key={s.sourceType} className="panel stat">
            <span className="sys-label">{s.sourceType}</span>
            <span className="text-3xl font-bold glow">{s.count}</span>
            <span className="text-xs text-faint">{fmtBytes(s.totalBytes)}</span>
          </div>
        ))}
        {memoryStats.length > 0 && (
          <div className="panel stat">
            <span className="sys-label">total</span>
            <span className="text-3xl font-bold glow">
              {memoryStats.reduce((sum, s) => sum + s.count, 0)}
            </span>
            <span className="text-xs text-faint">{fmtBytes(totalBytes)}</span>
          </div>
        )}
      </div>

      <div className="panel overflow-x-auto" style={{ padding: 0 }}>
        <table className="table w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left">Key</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Scope</th>
              <th className="px-3 py-2 text-right">Size</th>
              <th className="px-3 py-2 text-left">Updated</th>
            </tr>
          </thead>
          <tbody>
            {memories.length === 0 && !dbError && (
              <tr>
                <td className="px-3 py-3 text-dim" colSpan={5}>
                  No memories — run the seed SQL and the crawl.
                </td>
              </tr>
            )}
            {memories.map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-2 mono text-xs max-w-md truncate">
                  {m.key || m.id}
                </td>
                <td className="px-3 py-2">
                  <span className="badge">{m.sourceType || "—"}</span>
                </td>
                <td className="px-3 py-2 text-dim">{m.scope || "—"}</td>
                <td className="px-3 py-2 text-right">{fmtBytes(m.bytes)}</td>
                <td className="px-3 py-2 text-dim whitespace-nowrap">
                  {fmtDate(m.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {memories.length === 300 && (
        <p className="text-xs text-faint">Showing the 300 most recently updated rows.</p>
      )}
    </div>
  );
}
