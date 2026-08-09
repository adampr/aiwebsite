// Status projections for the submit page poll (§5.16). Never leaks another
// user's data: routes only call these on rows the caller owns (or as admin).

import { WORK_CAPS } from "./config";
import { UPDATE_CONFLICT_NOTE, type SubmissionListRow } from "./db";
import { sameEmail } from "./transfer";

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
  /** §5.16: this row proposes to replace a published card. */
  isUpdate: boolean;
  /** §5.16 chain ownership (2026-08-04): on a superseded row, the id of the
   * card's current LIVE version, so the list can offer "Submit an update"
   * even when the last update came from someone else (whose published row
   * is not in this submitter's list). Null everywhere else. */
  currentId: string | null;
  /** §5.16 admin web auto-approve: a passing panel run swaps this row live
   * itself, so pending_approval is a moments-long transit state, not a wait.
   * The client keeps polling and shows "Publishing" instead of "Waiting for
   * approval" (which would otherwise freeze on screen: the poll used to stop
   * on park, recreating the exact annoyance the auto lane removes). */
  autoApprove: boolean;
  /** §5.16 transfer round: who owns this submission right now. On the
   * submitter's own list this is always the viewer, so it renders nowhere;
   * the admin "All submissions" view is what needs it. Safe to project on
   * every row because every caller of statusView is already owner-or-admin
   * (the file header's standing rule). */
  owner: string;
  /** The row's CREATOR when a transfer has moved it since, else null.
   * Provenance for a card that reads "submitted by" someone who did not
   * create the row; also the reason the quota did not move with it. */
  movedFrom: string | null;
  /** Which page this row publishes to, as a label rather than the company
   * UUID: the all-submissions list mixes lanes and two rows under one title
   * would otherwise be indistinguishable. */
  lane: "internal" | "company";
  /** Company lane only, and only on the admin all-submissions list: the
   * company's display name and registered domain. The chip needs the name to
   * tell two tenants apart, and the move field needs the DOMAIN because it is
   * the only address family the route will accept for that row - without it
   * the admin has to guess and read it back off a refusal. Null on the staff
   * lane and on the own-list path, which never mixes tenants. */
  laneName: string | null;
  laneDomain: string | null;
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

// Takes the NARROW row type (db.ts SubmissionListRow), not SubmissionRow: the
// list read selects only these columns to keep the 10 s poll cheap, and a full
// SubmissionRow still satisfies it, so the [id] caller is unaffected.
export function statusView(
  row: SubmissionListRow,
  opts?: {
    currentId?: string | null;
    lane?: { name: string; domain: string } | null;
  }
): SubmissionStatusView {
  let stage: string | null = null;
  try {
    const progress = JSON.parse(row.panelProgressJson ?? "null") as {
      stage?: string;
      stageIndex?: number;
      stageCount?: number;
    } | null;
    if (row.status === "running" && progress?.stage)
      stage = `${progress.stage} (${(progress.stageIndex ?? 0) + 1} of ${progress.stageCount ?? 9})`;
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
    // Held UPDATE rows get a canned line: panel_error can carry admin-only
    // instructions (the conflict-park note), and rendering those to the
    // submitter hands them steps they cannot take (refutation finding,
    // 2026-08-03). The full reason still reaches the admin on /admin/work
    // and in the held email.
    heldReason:
      row.status === "held"
        ? row.parentId
          ? // A conflict park is a dead end, not a wait: the target card is
            // gone and Approve is suppressed, so "waiting on Adam" would
            // misstate it (the auto lane makes this a normal machine
            // outcome the submitting admin actually sees).
            row.panelError === UPDATE_CONFLICT_NOTE
            ? "This update could not be applied because the card it targeted is no longer on /work. Adam has been notified."
            : "This proposed update is waiting on Adam. The live card stays up meanwhile."
          : friendlyHeldReason(row.panelError)
        : null,
    slug: row.status === "published" ? row.slug : null,
    stale,
    createdAt: row.createdAt.toISOString(),
    isUpdate: !!row.parentId,
    currentId: opts?.currentId ?? null,
    // heldAt is part of the projection, not just the gate: a once-held auto
    // row parks BY DESIGN (heldAt one-shot), and without this conjunct the
    // client would show "Publishing" forever on a row that is waiting for
    // the click (refutation MAJOR, 2026-08-03).
    autoApprove: !!row.parentId && row.autoApprove && row.heldAt === null,
    owner: row.submitterEmail,
    movedFrom:
      row.creatorEmail && !sameEmail(row.creatorEmail, row.submitterEmail)
        ? row.creatorEmail
        : null,
    lane: row.companyId === null ? "internal" : "company",
    laneName: row.companyId === null ? null : (opts?.lane?.name ?? null),
    laneDomain: row.companyId === null ? null : (opts?.lane?.domain ?? null),
  };
}
