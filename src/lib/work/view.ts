// Status projections for the submit page poll (§5.16). Never leaks another
// user's data: routes only call these on rows the caller owns (or as admin).

import { WORK_CAPS } from "./config";
import type { SubmissionRow } from "./db";

export interface SubmissionStatusView {
  id: string;
  title: string;
  kind: string;
  status: string;
  stage: string | null;
  error: string | null;
  heldReason: string | null;
  slug: string | null;
  stale: boolean;
  createdAt: string;
}

// Plain-language labels for the machine-written panel_error checklist keys.
// Falls back to the raw string when the format is unrecognized, so a future
// panel.ts wording change degrades to raw text, never to nothing.
const CHECK_LABELS: Record<string, string> = {
  client_or_served_org_names: "Possible client or company names",
  client_or_company_names: "Possible client or company names",
  personal_names: "A person's name",
  hostnames_or_ips: "Hostnames or IP addresses",
  credentials_or_key_shaped_strings: "Credential-shaped text",
  dollar_figures: "Dollar figures",
  ticket_numbers: "Ticket numbers",
  email_addresses: "Email addresses",
  phone_numbers: "Phone numbers",
};

export function friendlyHeldReason(panelError: string | null): string | null {
  if (!panelError) return null;
  const lines = panelError.split("\n").slice(1); // drop the "hit:" header
  const parsed: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([a-z_]+)(?:\s*\([^)]*\))?:\s*(.*)$/);
    if (!m) return panelError; // unrecognized format: show raw
    parsed.push(`${CHECK_LABELS[m[1]] ?? m[1]}: ${m[2]}`);
  }
  return parsed.length > 0 ? parsed.join("\n") : panelError;
}

export function statusView(row: SubmissionRow): SubmissionStatusView {
  let stage: string | null = null;
  try {
    const progress = JSON.parse(row.panelProgressJson ?? "null") as {
      stage?: string;
      stageIndex?: number;
      stageCount?: number;
    } | null;
    if (row.status === "running" && progress?.stage)
      stage = `${progress.stage} (${(progress.stageIndex ?? 0) + 1} of ${progress.stageCount ?? 7})`;
  } catch {
    stage = null;
  }
  const stale =
    row.status === "running" &&
    (!row.panelHeartbeatAt ||
      Date.now() - row.panelHeartbeatAt.getTime() > WORK_CAPS.panelStaleMs);
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    stage,
    error: row.status === "failed" ? row.panelError : null,
    heldReason:
      row.status === "held" ? friendlyHeldReason(row.panelError) : null,
    slug: row.status === "published" ? row.slug : null,
    stale,
    createdAt: row.createdAt.toISOString(),
  };
}
