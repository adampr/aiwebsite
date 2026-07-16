// Troy approval loop: the PURE pieces (§5.12). Command grammar parsing,
// bounds validation, sender allowlisting, and header sanitization live here
// with no node/DB imports so scripts/governance-tests.ts exercises every
// branch. Email is a spoofable channel and these commands change runtime
// spend limits: everything in this file leans strict and fail-closed.
// No em dashes in any string (site rule).

import { BUDGET_CEILINGS, BUDGET_FLOOR } from "./config";

export type BudgetTarget = "global_brain" | "global_tavily" | "person_creates";

export interface ApprovalCommand {
  action: "set" | "reset";
  target: BudgetTarget;
  value: number | null; // null for reset
  line: string; // the exact matched line, for the confirmation email
}

/** Human names used in email copy and audit rows. */
export const TARGET_LABELS: Record<BudgetTarget, string> = {
  global_brain: "GLOBAL BRAIN",
  global_tavily: "GLOBAL TAVILY",
  person_creates: "PERSON CREATES",
};

export const TARGET_CEILINGS: Record<BudgetTarget, number> = {
  global_brain: BUDGET_CEILINGS.brainDaily,
  global_tavily: BUDGET_CEILINGS.tavilyDaily,
  person_creates: BUDGET_CEILINGS.createsPerUserPerDay,
};

/** governance_meta override keys, one per target. */
export const OVERRIDE_KEYS: Record<BudgetTarget, string> = {
  global_brain: "budget_override_brain_daily",
  global_tavily: "budget_override_tavily_daily",
  person_creates: "budget_override_creates_per_user_day",
};

/** governance_meta alert-throttle stamp keys, one per target. */
export const ALERT_STAMP_KEYS: Record<BudgetTarget, string> = {
  global_brain: "budget_alert_global_brain",
  global_tavily: "budget_alert_global_tavily",
  person_creates: "budget_alert_person_creates",
};

const TARGET_BY_PHRASE: Record<string, BudgetTarget> = {
  "GLOBAL BRAIN": "global_brain",
  "GLOBAL TAVILY": "global_tavily",
  "PERSON CREATES": "person_creates",
};

// Stop scanning at the first quoted-reply marker so text quoted from the
// alert email (or any earlier thread turn) can never register as a command.
// Belt and suspenders: alert emails only ever show placeholder syntax
// ("SET GLOBAL BRAIN <number>"), which the digit-only grammar cannot match.
const QUOTE_MARKERS: RegExp[] = [
  /^>/,
  /^On .{4,200} wrote:$/,
  /^-{2,}\s*Original Message/i,
  /^-{4,}\s*Forwarded/i,
  /^From:\s/,
  /^-- $/,
];

const SET_RE = /^SET (GLOBAL BRAIN|GLOBAL TAVILY|PERSON CREATES) (\d{1,7})$/i;
const RESET_RE = /^RESET (GLOBAL BRAIN|GLOBAL TAVILY|PERSON CREATES)$/i;

/**
 * Parse budget commands from a reply body. Strict: full-line anchored, one
 * command per line, scanning top-down and stopping at the first quoted-reply
 * marker. Anything else is ignored (counted, never guessed at).
 */
export function parseApprovalCommands(body: string): {
  commands: ApprovalCommand[];
  ignoredLines: number;
} {
  const commands: ApprovalCommand[] = [];
  let ignoredLines = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (QUOTE_MARKERS.some((m) => m.test(line))) break;
    if (!line) continue;
    const set = SET_RE.exec(line);
    if (set) {
      commands.push({
        action: "set",
        target: TARGET_BY_PHRASE[set[1].toUpperCase()],
        value: parseInt(set[2], 10),
        line,
      });
      continue;
    }
    const reset = RESET_RE.exec(line);
    if (reset) {
      commands.push({
        action: "reset",
        target: TARGET_BY_PHRASE[reset[1].toUpperCase()],
        value: null,
        line,
      });
      continue;
    }
    ignoredLines++;
  }
  return { commands, ignoredLines };
}

/**
 * Validate one command. Out-of-range values are REJECTED, never clamped:
 * the approver must never believe a number that is not actually in effect.
 */
export function validateCommand(
  cmd: ApprovalCommand
): { ok: true } | { ok: false; reason: string } {
  if (cmd.action === "reset") return { ok: true };
  const ceiling = TARGET_CEILINGS[cmd.target];
  if (
    cmd.value === null ||
    !Number.isInteger(cmd.value) ||
    cmd.value < BUDGET_FLOOR ||
    cmd.value > ceiling
  )
    return {
      ok: false,
      reason: `allowed range is ${BUDGET_FLOOR} to ${ceiling}`,
    };
  return { ok: true };
}

/** Clamp any configured value (env or override) into the legal range. */
export function clampBudget(value: number, ceiling: number): number {
  if (!Number.isFinite(value)) return BUDGET_FLOOR;
  return Math.min(Math.max(Math.trunc(value), BUDGET_FLOOR), ceiling);
}

/** Bare lowercase address out of "Display Name <addr>" or a plain addr. */
export function extractAddress(raw: string): string {
  const angled = /<([^<>\s]{3,320})>/.exec(raw);
  const addr = (angled ? angled[1] : raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : "";
}

/**
 * Exact-match membership in the comma-separated ADMIN_EMAIL list. Substring
 * checks would accept adam@xl.net.evil.com; this never does.
 */
export function isApprovedSender(
  fromRaw: string,
  adminEmailEnv: string | undefined
): boolean {
  const from = extractAddress(fromRaw);
  if (!from) return false;
  return (adminEmailEnv || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .includes(from);
}

/**
 * Header-safe string for Subject/In-Reply-To/References on outbound sends:
 * strips CR/LF/NUL (header injection) and length-caps. Never trust inbound
 * mail content in outbound headers.
 */
export function sanitizeHeaderValue(raw: string, max = 200): string {
  return raw.replace(/[\r\n\0]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * DKIM-replay freshness: a captured approval email replayed into the inbound
 * webhook after the dedupe TTL would otherwise verify cleanly. The Date
 * header is DKIM-covered; missing or older than maxAgeMs (or absurdly in the
 * future) fails closed.
 */
export function isFreshDate(
  dateHeader: string | undefined,
  nowMs: number,
  maxAgeMs = 48 * 3_600_000
): boolean {
  if (!dateHeader) return false;
  const t = Date.parse(dateHeader);
  if (!Number.isFinite(t)) return false;
  return t <= nowMs + 3_600_000 && nowMs - t <= maxAgeMs;
}

export const REPLY_SYNTAX_BLOCK = [
  "Reply to this email from an admin address with one command per line:",
  "",
  "SET GLOBAL BRAIN <number>      (brain calls per day, all users; 1 to " +
    `${BUDGET_CEILINGS.brainDaily})`,
  "SET GLOBAL TAVILY <number>     (research searches per day, all users; 1 to " +
    `${BUDGET_CEILINGS.tavilyDaily})`,
  "SET PERSON CREATES <number>    (new projects per person per day; 1 to " +
    `${BUDGET_CEILINGS.createsPerUserPerDay})`,
  "RESET GLOBAL BRAIN             (return to the configured default; same for the other two)",
  "",
  "Changes apply immediately, survive restarts, and are confirmed by reply.",
].join("\n");
