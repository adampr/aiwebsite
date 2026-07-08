"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ComposeForm({
  defaultTo = "",
  defaultSubject = "",
  sessionId,
}: {
  defaultTo?: string;
  defaultSubject?: string;
  sessionId?: string;
}) {
  const router = useRouter();
  const [to, setTo] = useState(defaultTo);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setNote(null);
    try {
      const res = await fetch("/api/admin/mailbox/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to.trim(), subject: subject.trim(), body: body.trim(), sessionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setNote(`Sent to ${to.trim()} (BCC adam@xl.net).`);
      setBody("");
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="panel stack" style={{ gap: "var(--sp-3)" }}>
      <span className="sys-label">{sessionId ? "Reply in this thread" : "Compose"}</span>
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          className="input mono"
          type="email"
          placeholder="recipient@example.com"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          required
          aria-label="Recipient"
        />
        <input
          className="input"
          placeholder="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={300}
          required
          aria-label="Subject"
        />
      </div>
      <textarea
        className="input"
        rows={5}
        placeholder="Message…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required
        aria-label="Message body"
      />
      <div className="row row--between flex-wrap">
        <p className="text-xs text-faint">
          Sends as Tron Netter &lt;Tron.Netter@ai.xl.net&gt;; adam@xl.net is BCC&apos;d
          automatically. Tron does not see manual sends in his conversation history.
        </p>
        <button type="submit" className="btn btn--primary" disabled={sending}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {note && <p className="text-xs text-dim">{note}</p>}
    </form>
  );
}
