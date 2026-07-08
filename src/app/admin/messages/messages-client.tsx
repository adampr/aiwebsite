"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtDate } from "@/lib/admin/format";

interface SmsMessage {
  sid: string;
  direction: string;
  from: string;
  to: string;
  body: string;
  status: string;
  dateSent: string | null;
  dateCreated: string | null;
}

type Direction = "all" | "inbound" | "outbound";

export function MessagesClient() {
  const [direction, setDirection] = useState<Direction>("all");
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [nextPageUri, setNextPageUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [replyTo, setReplyTo] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<string | null>(null);

  const load = useCallback(
    async (dir: Direction, pageUri?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (dir !== "all") params.set("direction", dir);
        if (pageUri) params.set("pageUri", pageUri);
        const res = await fetch(`/api/admin/messages?${params}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setMessages((prev) => (pageUri ? [...prev, ...data.messages] : data.messages));
        setNextPageUri(data.nextPageUri);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load messages");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    load(direction);
  }, [direction, load]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setSendNote(null);
    try {
      const res = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: replyTo.trim(), body: replyBody.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSendNote(`Sent to ${replyTo.trim()}.`);
      setReplyBody("");
      load(direction);
    } catch (err) {
      setSendNote(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="stack" style={{ gap: "var(--sp-6)" }}>
      <div className="row flex-wrap" style={{ gap: "var(--sp-3)" }}>
        {(["all", "inbound", "outbound"] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDirection(d)}
            className={`badge ${direction === d ? "badge--light" : ""}`}
            style={{ cursor: "pointer" }}
          >
            {d}
          </button>
        ))}
      </div>

      <form onSubmit={handleSend} className="panel stack" style={{ gap: "var(--sp-3)" }}>
        <span className="sys-label">Send SMS as Tron&apos;s number</span>
        <div className="row flex-wrap" style={{ gap: "var(--sp-3)", alignItems: "stretch" }}>
          <input
            className="input mono"
            style={{ maxWidth: "14rem" }}
            placeholder="+13125551234"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            required
            aria-label="Recipient phone number"
          />
          <input
            className="input flex-1"
            placeholder="Message…"
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            maxLength={1600}
            required
            aria-label="Message body"
          />
          <button type="submit" className="btn btn--primary" disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
        {sendNote && <p className="text-xs text-dim">{sendNote}</p>}
        <p className="text-xs text-faint">
          Sent from (872) 350-4325. Tron replies to inbound texts autonomously — a
          manual reply is invisible to his conversation history, so use sparingly.
        </p>
      </form>

      {error && <p className="panel text-sm text-dim">{error}</p>}

      <div className="panel overflow-x-auto" style={{ padding: 0 }}>
        <table className="table w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left">Dir</th>
              <th className="px-3 py-2 text-left">Counterparty</th>
              <th className="px-3 py-2 text-left">Message</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Time</th>
              <th className="px-3 py-2 text-left"></th>
            </tr>
          </thead>
          <tbody>
            {messages.length === 0 && !loading && (
              <tr>
                <td className="px-3 py-3 text-dim" colSpan={6}>
                  No messages.
                </td>
              </tr>
            )}
            {messages.map((m) => {
              const inbound = m.direction.startsWith("inbound");
              const counterparty = inbound ? m.from : m.to;
              return (
                <tr key={m.sid}>
                  <td className="px-3 py-2">
                    <span className={`badge ${inbound ? "badge--warn" : "badge--ok"}`}>
                      {inbound ? "in" : "out"}
                    </span>
                  </td>
                  <td className="px-3 py-2 mono text-xs whitespace-nowrap">{counterparty}</td>
                  <td className="px-3 py-2 max-w-lg">
                    <span className="line-clamp-3 whitespace-pre-wrap">{m.body}</span>
                  </td>
                  <td className="px-3 py-2 text-dim">{m.status}</td>
                  <td className="px-3 py-2 text-dim whitespace-nowrap">
                    {fmtDate(m.dateSent ?? m.dateCreated)}
                  </td>
                  <td className="px-3 py-2">
                    {inbound && (
                      <button
                        className="btn btn--text text-xs"
                        onClick={() => {
                          setReplyTo(counterparty);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        Reply
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ gap: "var(--sp-3)" }}>
        {loading && <span className="text-sm text-dim">Loading…</span>}
        {!loading && nextPageUri && (
          <button className="btn" onClick={() => load(direction, nextPageUri)}>
            Load older
          </button>
        )}
        {!loading && !nextPageUri && direction === "all" && messages.length > 0 && (
          <span className="text-xs text-faint">
            Showing the most recent messages — pick a direction filter to page further back.
          </span>
        )}
      </div>
    </div>
  );
}
