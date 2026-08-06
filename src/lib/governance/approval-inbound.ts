// Budget approval-loop inbound handling (§5.12). Since the 2026-08-06
// one-persona refit there is no separate approval mailbox: admin replies
// carrying SET/RESET commands arrive at the persona mailbox (or the retired
// legacy alias kept in channels.email.additionalMailboxes) like any other
// mail. channels.email.onInbound probes the content (probeApprovalMail,
// pure) and AWAITS this handler, which returns "handled" | "delegate".
//
// SECURITY INVARIANT: untrusted message content selects only the LANE
// (approval vs conversational); DKIM + ADMIN_EMAIL select the AUTHORITY
// (whether a budget may change). The fail-closed command gates are
// unchanged, in order: sender is an exact ADMIN_EMAIL member -> exactly ONE
// direct Authentication-Results header -> DKIM-aligned verdict pinned to
// the deployment authserv-id -> DKIM-covered Date fresh -> delivery dedupe
// (email_id, server-assigned) -> message dedupe (message_id, DKIM-replay
// guard) -> parse strict commands -> apply bounded overrides -> audit ->
// threaded confirmation.
//
// NOTHING IS DROPPED (owner directive 2026-08-06): a command-shaped mail
// that fails a gate is never applied, but it returns "delegate" so the
// module's conversational path answers it as Tron, and the admin gets a
// throttled WARN saying no budget changed. The old silent-drop posture (and
// the "I did not find a budget command" lecture for ordinary replies) are
// retired: ordinary mail never enters this handler at all.
// Log lines never contain body content.

import crypto from "node:crypto";
import type { InboundEmailHookContext } from "@aicompany/core/config/types";
import { parseEmailAuthVerdict } from "@aicompany/core/memory/email-auth";
import { reportFailureEmailIssue } from "@/lib/report-issue";
import { siteConfig } from "site.config";
import {
  ALERT_STAMP_KEYS,
  OVERRIDE_KEYS,
  REPLY_SYNTAX_BLOCK,
  TARGET_LABELS,
  extractAddress,
  isApprovedSender,
  isFreshDate,
  parseApprovalCommands,
  probeApprovalMail,
  sanitizeHeaderValue,
  validateCommand,
  type ApprovalCommand,
} from "./approval";
import {
  adminRecipient,
  describeBudgets,
  sendGovernanceEmail,
} from "./budget";
import {
  claimMetaOnce,
  deleteMeta,
  getMeta,
  setMeta,
  readTodayUsage,
} from "./db";

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

/** Throttled WARN to the admin (1/24h per reason class), never to the
 * sender. Since 2026-08-06 this no longer announces a drop: it announces a
 * command that was NOT APPLIED while the mail itself was answered
 * conversationally on the delegate path. */
async function warnAdmin(
  reason: string,
  fromRaw: string,
  subjectRaw: string
): Promise<void> {
  // §5.15 mirror: episodic per reason class (no email id in the key; the
  // 500-row triage window is why), throttled repeats bump `count`.
  const mirror = (emailed: boolean): void =>
    reportFailureEmailIssue({
      key: `governance:budget-command-unverified:${reason}`,
      subject: `Budget command not applied (${reason})`,
      detail: [
        `A budget command arrived at the persona mailbox that could not be verified, so no budget changed.`,
        `Reason: ${reason}`,
        `From: ${sanitizeHeaderValue(fromRaw, 120)}`,
        `Subject: ${sanitizeHeaderValue(subjectRaw, 120)}`,
        `The sender was answered conversationally; nothing was dropped.`,
      ].join("\n"),
      emailed,
    });
  const stampKey = `gov_reject_${reason}`;
  const stamp = await getMeta(stampKey);
  if (stamp && Date.now() - Date.parse(stamp) < 23.5 * 3_600_000) {
    log(`command not applied (${reason}); WARN throttled`);
    mirror(false);
    return;
  }
  const sent = await sendGovernanceEmail({
    subject: `[aiwebsite] WARN budget command not applied (${reason})`,
    text: [
      `A budget command arrived at ${siteConfig.channels.email.mailbox} that I could not verify, so no budget changed.`,
      ``,
      `Reason: ${reason}`,
      `From: ${sanitizeHeaderValue(fromRaw, 120)}`,
      `Subject: ${sanitizeHeaderValue(subjectRaw, 120)}`,
      ``,
      `The sender was answered conversationally; nothing was dropped. Budget commands are applied only for DKIM-verified mail from an ADMIN_EMAIL address. If this was you, resend from the admin mailbox; this notice repeats at most once per day per reason.`,
    ].join("\n"),
  });
  if (sent) await setMeta(stampKey, new Date().toISOString());
  mirror(sent);
}

/**
 * Probe-handler for one inbound delivery that LOOKED command-shaped.
 * AWAITED by channels.email.onInbound (legal: the module ACKs Svix and
 * detaches before the hook runs). Returns "handled" when this lane owns the
 * outcome (applied, refused-with-reply, or duplicate) and "delegate" when
 * the conversational path should answer instead. Reads the message the
 * module already fetched (ctx.email); no second receiving.get.
 *
 * NEVER THROWS past its own catch: the module treats a throwing hook as
 * "delegate", which after an applied command or a sent confirmation would
 * produce a second, conversational answer on top of a completed budget
 * change. The catch therefore reports "handled" once a side effect could
 * have started, and before that releases the dedupe claims and delegates.
 */
export async function handleApprovalInbound(
  ctx: InboundEmailHookContext
): Promise<"handled" | "delegate"> {
  let claimed = false;
  const claimKeys: string[] = [];
  const fromRaw = ctx.email.from ?? "";
  const subjectRaw = ctx.email.subject ?? "";
  try {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(ctx.emailId)) {
      log("malformed email_id; delegating");
      return "delegate";
    }
    // Recomputed here (pure, cheap) so this handler is self-contained even
    // though onInbound probed once already to pick the lane.
    const probe = probeApprovalMail(ctx.email.text, ctx.email.html);
    if (probe === "none") return "delegate";

    // ── Fail-closed sender verification (gates unchanged) ────────────
    if (!isApprovedSender(fromRaw, process.env.ADMIN_EMAIL)) {
      await warnAdmin("sender_not_admin", fromRaw, subjectRaw);
      return "delegate";
    }
    // Exactly ONE direct Authentication-Results header. A forged AR header
    // riding alongside the receiver's genuine one makes header selection
    // ambiguous (first-match wins in the parser); ambiguity here is a
    // refusal, and the ARC fallback is not accepted for this gate.
    const headers = ctx.email.headers ?? null;
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
      return "delegate";
    }
    const verdict = parseEmailAuthVerdict(headers, fromRaw, siteConfig);
    if (!verdict.authenticated) {
      await warnAdmin(`auth_${verdict.reason ?? "failed"}`, fromRaw, subjectRaw);
      return "delegate";
    }
    // DKIM-replay freshness: the Date header is DKIM-covered; stale or
    // missing refuses (dedupe rows are pruned at 14 days, so an old captured
    // approval could otherwise be replayed after the prune).
    if (!isFreshDate(headerLookupLocal(headers, "date"), Date.now())) {
      await warnAdmin("stale_or_missing_date", fromRaw, subjectRaw);
      return "delegate";
    }

    // ── Dedupe claims, POST-verification (2026-08-06: the handler now sees
    // command-shaped mail from anyone, so a pre-verification claim would
    // write one governance_meta row per spam delivery; the gates above are
    // pure header math, so re-running them on a redelivery costs nothing).
    // A loss at either claim means this delivery was already processed and
    // answered: "handled", no second reply. ──────────────────────────
    const eidClaimKey = `gov_msg_${hashKey(`eid:${ctx.emailId}`)}`;
    if (!(await claimMetaOnce(eidClaimKey, "seen"))) {
      log("duplicate delivery; already processed");
      return "handled";
    }
    claimKeys.push(eidClaimKey);
    const messageId = ctx.email.messageId || "";
    if (messageId) {
      const midClaimKey = `gov_msg_${hashKey(`mid:${messageId}`)}`;
      if (!(await claimMetaOnce(midClaimKey, "seen"))) {
        log("duplicate message_id; already processed");
        return "handled";
      }
      claimKeys.push(midClaimKey);
    }

    // ── Parse + apply ────────────────────────────────────────────────
    const replyHeaders: Record<string, string> = {};
    if (messageId) {
      const clean = sanitizeHeaderValue(messageId, 250);
      replyHeaders["In-Reply-To"] = clean;
      replyHeaders["References"] = clean;
    }
    const replySubject = `Re: ${sanitizeHeaderValue(subjectRaw, 150) || "Governance budgets"}`;
    // Reply to the VERIFIED SENDER (any ADMIN_EMAIL member), not the first
    // list entry: a second admin's command used to be applied with the
    // confirmation sent to adam only, leaving the actual sender in silence
    // (refutation finding 2026-08-06). The owner still sees every reply via
    // the unconditional oversight BCC in sendGovernanceEmail.
    const senderAddr = extractAddress(fromRaw) || adminRecipient();
    // A command that arrived on a thread NOT addressed to the persona
    // mailbox came via the retired legacy alias; say once why the From line
    // changed mid-thread. No address is named here so this file stays free
    // of the retired persona (the alias lives in site.config only).
    const personaBox = siteConfig.channels.email.mailbox.toLowerCase();
    const viaLegacyAlias = !ctx.envelopeRecipients.some(
      (r) => r.toLowerCase() === personaBox
    );
    const aliasNote = viaLegacyAlias
      ? [
          ``,
          `Note: I now send from ${siteConfig.channels.email.mailbox}; the address this thread started from is retired and mail to it reaches me.`,
        ]
      : [];

    if (probe === "html_only_commands") {
      claimed = true;
      // Verified admin, but the command exists only in the HTML body.
      // Commands are applied ONLY from plain text (HTML quoting does not
      // survive tag-stripping as the quote markers the parser stops at, so
      // a quoted old command would re-execute). Answer in THIS lane rather
      // than delegating: a conversational model could otherwise imply a cap
      // changed when nothing did.
      const sent = await sendGovernanceEmail({
        to: senderAddr,
        subject: replySubject,
        headers: replyHeaders,
        text: [
          `I only read budget commands from the plain-text part of an email, and this message had no plain-text command line, so nothing changed. Resend the command as plain text.`,
          ``,
          REPLY_SYNTAX_BLOCK,
          ...aliasNote,
        ].join("\n"),
      });
      reportFailureEmailIssue({
        key: `governance:budget-command:html-only`,
        subject: `Budget command arrived HTML-only; not applied`,
        detail: [
          `A verified admin reply carried a budget command only in its HTML body, so nothing was applied.`,
          sent
            ? `The plain-text-only note and syntax block went back to the admin.`
            : `The reply did NOT go out, so the admin does not know the command was skipped.`,
          `Subject: ${sanitizeHeaderValue(subjectRaw, 150) || "(none)"}`,
        ].join("\n"),
        emailed: sent,
      });
      return "handled";
    }

    const { commands, ignoredLines } = parseApprovalCommands(
      ctx.email.text ?? ""
    );
    if (commands.length === 0) {
      // Unreachable by construction: probe === "text_commands" ran the same
      // pure parser over the same bytes. Delegate so nothing is dropped.
      log("probe/parse disagreement; delegating");
      return "delegate";
    }

    claimed = true;
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
          emailId: ctx.emailId,
          messageId: messageId.slice(0, 200),
        })
      );
    }
    // A changed budget alerts again the same day if re-hit at the new cap.
    for (const t of changedTargets) await deleteMeta(ALERT_STAMP_KEYS[t]);

    const after = await describeBudgets();
    const usage = await readTodayUsage();
    const rejectedCount = outcomes.filter((o) =>
      o.startsWith("rejected")
    ).length;
    log(`applied=${changedTargets.size} rejected=${rejectedCount} by=${senderAddr}`);
    const confirmationSent = await sendGovernanceEmail({
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
        ...aliasNote,
      ].join("\n"),
    });
    if (changedTargets.size === 0) {
      // Every command was out of range or malformed past the grammar. The
      // confirmation lists each rejection, but a repeatedly mistyped cap
      // should also be visible in the triage. Episodic key; emailed reflects
      // the actual send result (a Resend outage must not stamp
      // last_emailed_at on a reply nobody received).
      reportFailureEmailIssue({
        key: `governance:budget-command:all-rejected`,
        subject: `Budget commands all rejected (out of range)`,
        detail: [
          `A verified admin reply carried ${commands.length} budget command(s) and every one was rejected.`,
          ...outcomes.map((o) => `- ${o}`),
          confirmationSent
            ? `The rejection list went back to the sender.`
            : `The reply did NOT go out, so the sender does not know the commands were rejected.`,
        ].join("\n"),
        emailed: confirmationSent,
      });
    }
    return "handled";
  } catch (err) {
    log(
      `unhandled: ${err instanceof Error ? err.message.slice(0, 150) : "unknown"}`
    );
    void warnAdmin("handler_error", fromRaw, subjectRaw).catch(() => {});
    // `claimed` flips only once a side effect (apply loop or in-lane reply)
    // could have started; past that point a "delegate" could produce a
    // second answer on top of an applied command or sent reply, so own the
    // outcome. BEFORE it, release the dedupe claims (best effort) and
    // delegate, so a transient DB error between claim and apply neither
    // drops the mail nor blocks a webhook redelivery from reprocessing it
    // (refutation finding 2026-08-06).
    if (!claimed) {
      for (const k of claimKeys) void deleteMeta(k).catch(() => {});
      return "delegate";
    }
    return "handled";
  }
}
