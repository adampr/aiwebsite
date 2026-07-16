// Runtime-mutable governance budgets + the Troy alert sender (§5.12).
// Effective cap = governance_meta override (set via the email approval loop)
// if present, else the env default; BOTH are clamped into
// [BUDGET_FLOOR, ceiling], so neither a subverted approval nor a mistyped
// env var can authorize unbounded spend. Read per request, no cache: one PK
// lookup on a tiny table, on routes that already hit the DB, and instant
// effect the moment an approval lands. Server-only (DB imports).

import {
  ALERT_STAMP_KEYS,
  OVERRIDE_KEYS,
  REPLY_SYNTAX_BLOCK,
  TARGET_CEILINGS,
  TARGET_LABELS,
  clampBudget,
  type BudgetTarget,
} from "./approval";
import {
  CAPS,
  brainDailyCap,
  tavilyDailyCap,
} from "./config";
import { getMeta, readTodayUsage, setMeta } from "./db";

async function overrideFor(target: BudgetTarget): Promise<number | null> {
  const raw = await getMeta(OVERRIDE_KEYS[target]);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function effectiveBrainDailyCap(): Promise<number> {
  const o = await overrideFor("global_brain");
  return clampBudget(o ?? brainDailyCap(process.env), TARGET_CEILINGS.global_brain);
}

export async function effectiveTavilyDailyCap(): Promise<number> {
  const o = await overrideFor("global_tavily");
  return clampBudget(o ?? tavilyDailyCap(process.env), TARGET_CEILINGS.global_tavily);
}

export async function effectiveCreatesPerUserPerDay(): Promise<number> {
  const o = await overrideFor("person_creates");
  return clampBudget(
    o ?? CAPS.createsPerUserPerDay,
    TARGET_CEILINGS.person_creates
  );
}

/** Current effective caps + whether each is an override (email copy/audit). */
export async function describeBudgets(): Promise<
  Record<BudgetTarget, { effective: number; overridden: boolean }>
> {
  const [brain, tavily, creates] = await Promise.all([
    overrideFor("global_brain"),
    overrideFor("global_tavily"),
    overrideFor("person_creates"),
  ]);
  return {
    global_brain: {
      effective: clampBudget(
        brain ?? brainDailyCap(process.env),
        TARGET_CEILINGS.global_brain
      ),
      overridden: brain !== null,
    },
    global_tavily: {
      effective: clampBudget(
        tavily ?? tavilyDailyCap(process.env),
        TARGET_CEILINGS.global_tavily
      ),
      overridden: tavily !== null,
    },
    person_creates: {
      effective: clampBudget(
        creates ?? CAPS.createsPerUserPerDay,
        TARGET_CEILINGS.person_creates
      ),
      overridden: creates !== null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Troy sends (Resend REST, host script-style send; the recipient IS the
 * overseer, so the module's BCC invariant is not in play here)
 * ------------------------------------------------------------------ */

export const TROY_FROM = "Troy Netter <Troy.Netter@ai.xl.net>";

export function adminRecipient(): string {
  return (
    (process.env.ADMIN_EMAIL || "").split(",")[0]?.trim() || "adam@xl.net"
  );
}

export async function sendTroyEmail(opts: {
  to?: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[gov-budget] EMAIL SKIPPED (no RESEND_API_KEY): ${opts.subject}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: TROY_FROM,
        to: [opts.to ?? adminRecipient()],
        subject: opts.subject,
        text: opts.text,
        ...(opts.headers ? { headers: opts.headers } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
      console.log(
        `[gov-budget] troy send failed ${res.status}: ${(await res.text()).slice(0, 150)}`
      );
    return res.ok;
  } catch (err) {
    console.log(
      `[gov-budget] troy send threw: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`
    );
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Budget-hit alerts: 1 email per budget type per UTC day. The stamp lives
 * in governance_meta (shared by the web process and the detached research
 * script, restart-proof) and is written ONLY after a successful send: a
 * Resend outage must not eat the day's only alert (the cost is a rare
 * duplicate in a web/script race, which is acceptable).
 * ------------------------------------------------------------------ */

export async function notifyBudgetHit(
  target: BudgetTarget,
  detail: { who?: string; operation?: string }
): Promise<void> {
  try {
    const stampKey = ALERT_STAMP_KEYS[target];
    const stamp = await getMeta(stampKey);
    const today = new Date().toISOString().slice(0, 10);
    if (stamp && stamp.slice(0, 10) === today) return;

    const [budgets, usage] = await Promise.all([
      describeBudgets(),
      readTodayUsage(),
    ]);
    const b = budgets[target];
    const lines = [
      `A governance budget was hit on ai.xl.net.`,
      ``,
      `Budget: ${TARGET_LABELS[target]}`,
      `Who: ${detail.who ?? "global, all users"}`,
      `Denied operation: ${detail.operation ?? "n/a"}`,
      ``,
      `Today's usage: brain calls ${usage.brainCalls}, research searches ${usage.tavilyCalls}, research runs ${usage.researchRuns}.`,
      `Effective caps: GLOBAL BRAIN ${budgets.global_brain.effective}${budgets.global_brain.overridden ? " (override)" : ""}, GLOBAL TAVILY ${budgets.global_tavily.effective}${budgets.global_tavily.overridden ? " (override)" : ""}, PERSON CREATES ${budgets.person_creates.effective}${budgets.person_creates.overridden ? " (override)" : ""}.`,
      `This budget is currently ${b.overridden ? "a runtime override set by email approval" : "the configured default"}.`,
      ``,
      `Note: the AI provider's own billing quota is the true ceiling; approving more here cannot exceed what the provider will serve.`,
      ``,
      REPLY_SYNTAX_BLOCK,
      ``,
      `Further hits of this budget today are suppressed; this notice repeats at most once per day per budget.`,
    ];
    const sent = await sendTroyEmail({
      subject: `[aiwebsite] Governance budget hit: ${TARGET_LABELS[target]}`,
      text: lines.join("\n"),
    });
    if (sent) await setMeta(stampKey, new Date().toISOString());
  } catch (err) {
    console.log(
      `[gov-budget] notifyBudgetHit failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`
    );
  }
}
