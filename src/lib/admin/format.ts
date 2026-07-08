// Shared formatting for /admin pages. All timestamps render in Chicago time
// (the business's timezone); brain tables store TEXT ISO strings and site
// tables store timestamptz, so accept both.
export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return (
    d.toLocaleString("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " CT"
  );
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

// "email:someone@x.com" → someone@x.com; phone numbers pass through.
export function requesterLabel(requesterId: string): string {
  return requesterId.replace(/^email:/, "");
}
