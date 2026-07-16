// Troy approval-loop inbound handling (§5.12): mail addressed to
// Troy.Netter@ai.xl.net, teed off the Resend webhook by the host wrapper.
// Every step is fail-closed; this path changes runtime spend limits.
//
// Order: dedupe the delivery (email_id, server-assigned) -> fetch the full
// message -> verify the sender (ADMIN_EMAIL exact match + exactly ONE
// direct Authentication-Results header + DKIM-aligned verdict pinned to the
// deployment authserv-id + DKIM-covered Date fresh) -> dedupe the message
// (message_id, DKIM-replay guard) -> parse strict commands -> apply bounded
// overrides -> audit -> threaded confirmation. Unverified mail gets NO reply
// (backscatter/probe hygiene); adam gets a throttled WARN instead so real
// mail never vanishes silently. Log lines never contain body content.

import crypto from "node:crypto";
import { Resend } from "resend";
import { parseEmailAuthVerdict } from "@aicompany/core/memory/email-auth";
import { siteConfig } from "site.config";
import {
  ALERT_STAMP_KEYS,
  OVERRIDE_KEYS,
  REPLY_SYNTAX_BLOCK,
  TARGET_LABELS,
  isApprovedSender,
  isFreshDate,
  parseApprovalCommands,
  sanitizeHeaderValue,
  validateCommand,
  type ApprovalCommand,
} from "./approval";
import {
  adminRecipient,
  describeBudgets,
  sendTroyEmail,
} from "./budget";
import {
  claimMetaOnce,
  deleteMeta,
  getMeta,
  readTodayUsage,
  setMeta,
} from "./db";

export const TROY_ADDRESS = "troy.netter@ai.xl.net";

function log(msg: string): void {
  console.log(`[gov-approval] ${new Date().toISOString()} ${msg}`);
}

function hashKey(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
}

function headerLookupLocal(
  headers: Record<string, string> | null,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers))
    if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Throttled WARN to the admin (1/24h per reason class), never to the sender. */
async function warnAdmin(
  reason: string,
  fromRaw: string,
  subjectRaw: string
): Promise<void> {
  const stampKey = `troy_reject_${reason}`;
  const stamp = await getMeta(stampKey);
  if (stamp && Date.now() - Date.parse(stamp) < 23.5 * 3_600_000) {
    log(`rejected (${reason}); WARN throttled`);
    return;
  }
  const sent = await sendTroyEmail({
    subject: `[aiwebsite] WARN mail to Troy.Netter dropped (${reason})`,
    text: [
      `Mail addressed to Troy.Netter@ai.xl.net was dropped without reply.`,
      ``,
      `Reason: ${reason}`,
      `From: ${sanitizeHeaderValue(fromRaw, 120)}`,
      `Subject: ${sanitizeHeaderValue(subjectRaw, 120)}`,
      ``,
      `Troy only acts on DKIM-verified replies from ADMIN_EMAIL addresses and never replies to anyone else. If this was you, resend from the admin mailbox; this notice repeats at most once per day per reason.`,
    ].join("\n"),
  });
  if (sent) await setMeta(stampKey, new Date().toISOString());
}

/**
 * Handle one inbound delivery to Troy. Fire-and-forget from the webhook tee
 * (the webhook must 2xx fast); all failures are logged, never thrown.
 */
export async function handleTroyInbound(emailId: string): Promise<void> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      log("RESEND_API_KEY unset; cannot fetch inbound (dev)");
      return;
    }
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(emailId)) {
      log("malformed email_id; ignoring");
      return;
    }

    // Delivery dedupe FIRST (safe pre-verification: email_id is
    // server-assigned per delivery) so webhook redeliveries process once.
    if (!(await claimMetaOnce(`troy_msg_${hashKey(`eid:${emailId}`)}`, "seen"))) {
      log("duplicate delivery; already processed");
      return;
    }

    const resend = new Resend(key);
    const { data: email, error } = await resend.emails.receiving.get(emailId);
    if (error || !email) {
      log(`fetch failed: ${error?.message?.slice(0, 120) ?? "no data"}`);
      await warnAdmin("fetch_failed", "(unknown)", "(unknown)");
      return;
    }
    const fromRaw = email.from ?? "";
    const subjectRaw = email.subject ?? "";

    // ── Fail-closed sender verification ──────────────────────────────
    if (!isApprovedSender(fromRaw, process.env.ADMIN_EMAIL)) {
      await warnAdmin("sender_not_admin", fromRaw, subjectRaw);
      return;
    }
    // Exactly ONE direct Authentication-Results header. A forged AR header
    // riding alongside the receiver's genuine one makes header selection
    // ambiguous (first-match wins in the parser); ambiguity here is a
    // rejection, and the ARC fallback is not accepted for this gate.
    const headers = email.headers ?? null;
    const arCount = headers
      ? Object.keys(headers).filter(
          (k) => k.toLowerCase() === "authentication-results"
        ).length
      : 0;
    if (arCount !== 1) {
      await warnAdmin(
        arCount === 0 ? "no_auth_results" : "duplicate_auth_results",
        fromRaw,
        subjectRaw
      );
      return;
    }
    const verdict = parseEmailAuthVerdict(
      headers,
      fromRaw,
      siteConfig
    );
    if (!verdict.authenticated) {
      await warnAdmin(`auth_${verdict.reason ?? "failed"}`, fromRaw, subjectRaw);
      return;
    }
    // DKIM-replay freshness: the Date header is DKIM-covered; stale or
    // missing fails closed (dedupe rows are pruned at 14 days, so an old
    // captured approval could otherwise be replayed after the prune).
    if (!isFreshDate(headerLookupLocal(headers, "date"), Date.now())) {
      await warnAdmin("stale_or_missing_date", fromRaw, subjectRaw);
      return;
    }
    // Message dedupe (post-verification so strangers cannot burn the key).
    const messageId = email.message_id || "";
    if (
      messageId &&
      !(await claimMetaOnce(`troy_msg_${hashKey(`mid:${messageId}`)}`, "seen"))
    ) {
      log("duplicate message_id; already processed");
      return;
    }

    // ── Parse + apply ────────────────────────────────────────────────
    const replyHeaders: Record<string, string> = {};
    if (messageId) {
      const clean = sanitizeHeaderValue(messageId, 250);
      replyHeaders["In-Reply-To"] = clean;
      replyHeaders["References"] = clean;
    }
    const replySubject = `Re: ${sanitizeHeaderValue(subjectRaw, 150) || "Governance budgets"}`;
    const senderAddr = adminRecipient();

    const { commands, ignoredLines } = parseApprovalCommands(email.text ?? "");
    if (commands.length === 0) {
      log(`verified reply with no commands (ignored lines: ${ignoredLines})`);
      await sendTroyEmail({
        to: senderAddr,
        subject: replySubject,
        headers: replyHeaders,
        text: [
          `I did not find a budget command in your reply, so nothing changed.`,
          ``,
          REPLY_SYNTAX_BLOCK,
        ].join("\n"),
      });
      return;
    }

    const before = await describeBudgets();
    const outcomes: string[] = [];
    const changedTargets = new Set<ApprovalCommand["target"]>();
    for (const cmd of commands) {
      const valid = validateCommand(cmd);
      if (!valid.ok) {
        outcomes.push(`rejected: "${cmd.line}" (${valid.reason})`);
        continue;
      }
      const old = before[cmd.target].effective;
      if (cmd.action === "set") {
        await setMeta(OVERRIDE_KEYS[cmd.target], String(cmd.value));
        outcomes.push(
          `applied: ${TARGET_LABELS[cmd.target]} ${old} -> ${cmd.value}`
        );
      } else {
        await deleteMeta(OVERRIDE_KEYS[cmd.target]);
        outcomes.push(
          `applied: ${TARGET_LABELS[cmd.target]} reset to the configured default`
        );
      }
      changedTargets.add(cmd.target);
      // Audit row: one per event, per-key so no read-modify-write races.
      await setMeta(
        `budget_audit_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`,
        JSON.stringify({
          at: new Date().toISOString(),
          actor: senderAddr,
          command: cmd.line,
          target: cmd.target,
          old,
          new: cmd.action === "set" ? cmd.value : "default",
          emailId,
          messageId: messageId.slice(0, 200),
        })
      );
    }
    // A changed budget alerts again the same day if re-hit at the new cap.
    for (const t of changedTargets) await deleteMeta(ALERT_STAMP_KEYS[t]);

    const after = await describeBudgets();
    const usage = await readTodayUsage();
    log(
      `applied=${changedTargets.size} rejected=${outcomes.filter((o) => o.startsWith("rejected")).length} by=${senderAddr}`
    );
    await sendTroyEmail({
      to: senderAddr,
      subject: replySubject,
      headers: replyHeaders,
      text: [
        `Budget commands processed:`,
        ``,
        ...outcomes.map((o) => `- ${o}`),
        ...(ignoredLines ? [``, `(${ignoredLines} non-command line${ignoredLines === 1 ? "" : "s"} ignored)`] : []),
        ``,
        `Effective caps now: GLOBAL BRAIN ${after.global_brain.effective}${after.global_brain.overridden ? " (override)" : ""}, GLOBAL TAVILY ${after.global_tavily.effective}${after.global_tavily.overridden ? " (override)" : ""}, PERSON CREATES ${after.person_creates.effective}${after.person_creates.overridden ? " (override)" : ""}.`,
        `Today's usage: brain calls ${usage.brainCalls}, research searches ${usage.tavilyCalls}.`,
        ``,
        `RESET returns a budget to its configured default. Overrides survive restarts and deploys.`,
      ].join("\n"),
    });
  } catch (err) {
    log(
      `unhandled: ${err instanceof Error ? err.message.slice(0, 150) : "unknown"}`
    );
  }
}
