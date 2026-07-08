import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";
import { listPhoneCalls, type PhoneCall } from "@/lib/brain-db";
import { fmtDate } from "@/lib/admin/format";

export const dynamic = "force-dynamic";

interface TranscriptTurn {
  role?: string;
  text?: string;
  at?: string;
}

function parseTranscript(raw: string | null): TranscriptTurn[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function durationLabel(call: PhoneCall): string {
  if (!call.endedAt) return "—";
  const ms = new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime();
  if (isNaN(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

// Voice calls on Tron's number are handled by the brain directly
// (Twilio → nginx → brain /twilio/*); this page reads its call log.
export default async function AdminCallsPage() {
  const session = await getSession();
  if (!session || !isAdmin(session.email)) redirect("/login");

  let calls: PhoneCall[] = [];
  let dbError = false;
  try {
    calls = await listPhoneCalls(100);
  } catch {
    dbError = true;
  }

  return (
    <div className="stack" style={{ gap: "var(--sp-6)" }}>
      <h1 className="text-2xl font-bold">Voice Calls</h1>

      {dbError && (
        <p className="panel text-sm text-dim">
          Brain tables unavailable — is brain-api running against this database?
        </p>
      )}
      {calls.length === 0 && !dbError && (
        <p className="panel text-sm text-dim">No calls recorded yet.</p>
      )}

      <div className="stack" style={{ gap: "var(--sp-4)" }}>
        {calls.map((call) => {
          const transcript = parseTranscript(call.transcript);
          return (
            <details key={call.id} className="panel">
              <summary className="cursor-pointer">
                <span className={`badge ${call.direction === "inbound" ? "badge--warn" : "badge--ok"}`}>
                  {call.direction}
                </span>{" "}
                <span className="mono text-sm">
                  {call.direction === "inbound" ? call.fromNumber : call.toNumber}
                </span>{" "}
                <span className="text-dim text-sm">
                  · {call.status} · {durationLabel(call)} · {fmtDate(call.startedAt)}
                </span>
                {call.purpose && <span className="text-faint text-sm"> · {call.purpose}</span>}
              </summary>
              <div className="stack mt-4" style={{ gap: "var(--sp-2)" }}>
                {transcript.length === 0 && (
                  <p className="text-dim text-sm">No transcript.</p>
                )}
                {transcript.map((t, i) => (
                  <div key={i} className="text-sm">
                    <span
                      className="text-xs"
                      style={{
                        color:
                          t.role === "assistant" || t.role === "tron"
                            ? "var(--xl-light-dim)"
                            : "var(--xl-sand)",
                      }}
                    >
                      {t.role ?? "?"}:
                    </span>{" "}
                    <span className="whitespace-pre-wrap">{t.text ?? ""}</span>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
