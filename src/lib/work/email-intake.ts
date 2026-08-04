// Email intake for team work submissions (§5.16): mail to
// Tron.Netter@ai.xl.net from a DKIM-verified @xl.net sender carrying an
// archive attachment enters the SAME pipeline as POST /api/work/submissions
// (extract -> secret scan -> duplicate-title guard -> createSubmission ->
// kickPanel). Mounted from site.config.ts channels.email.onInbound after the
// Troy branch: an archive-shaped staff email is claimed ("handled") so the
// module never answers it conversationally; everything else delegates.
//
// Trust model (Troy approval-inbound pattern, §5.12): the From header is
// spoofable, so before ANY reply or side effect the sender must clear the
// fail-closed gate — exactly ONE direct Authentication-Results header,
// DKIM-aligned verdict pinned to the deployment authserv-id, DKIM-covered
// Date fresh, message_id replay dedupe. Unverified mail gets NO reply
// (backscatter hygiene); the admin gets a throttled WARN instead. Verified
// senders get a Tron reply for every validation failure (the email
// equivalent of the route's 4xx bodies) and a receipt on acceptance.
// Log lines never contain body content.

import crypto from "node:crypto";
import { oversightBcc } from "@/lib/oversight-bcc";
import { Resend } from "resend";
import { isAdmin } from "@aicompany/core/auth/guard";
import { checkRateLimit } from "@aicompany/core/lib/rate-limit";
import { parseEmailAuthVerdict } from "@aicompany/core/memory/email-auth";
import type { InboundEmailHookContext } from "@aicompany/core/config/types";
import { siteConfig } from "site.config";
import {
  extractAddress,
  isFreshDate,
  sanitizeHeaderValue,
} from "@/lib/governance/approval";
import { brainHealthy } from "@/lib/governance/brain";
import { claimMetaOnce, getMeta, setMeta } from "@/lib/governance/db";
import {
  MISSING_ARCH_DOC_MESSAGE,
  TITLE_KIND_PREFIX_RE,
  WORK_CAPS,
  workSubmissionsEnabled,
  type WorkKind,
} from "./config";
import {
  activeTitleClash,
  countCreatedToday,
  countCreatedTodayForCompany,
  createSubmission,
  isUniqueViolation,
  normalizeTitle,
  publishedTitleClash,
  resolveUpdateTarget,
  userIdForEmail,
  type SubmissionRow,
} from "./db";
import type { WorkScope } from "./scope";
import { tronSignature } from "@/lib/tron-signature";
import { emailDomain } from "@/lib/rfp/access";
import { ROADMAP_CAPS, roadmapBrainDailyCap, roadmapEnabled } from "@/lib/roadmap/config";
import {
  companyForDomainRow,
  readTodayRoadmapUsage,
  recordRoadmapBrainCall,
  type CompanyRow,
} from "@/lib/roadmap/db";
import {
  archiveDeclaredNames,
  docDeclaredNames,
  FORM_POINTER,
  inferKind,
  HOSTILE_TITLE_CHARS,
  isPlaceholderSubject,
  isSenderIdentity,
  nameKey,
  parseSubmissionBody,
  pickAttachments,
  pickSkillDoc,
  resolveSubjectTitle,
  senderIdentityTokens,
  stripMachineEcho,
  titleFromSubject,
  UPDATE_SUBJECT_RE,
  validateWeakTitle,
  type AttachmentMeta,
} from "./email-parse";
import { inferTitleFromEmail } from "./title-infer";
import {
  inspectArchive,
  inspectBareMd,
  mergeSkillCorpus,
  skillDocFailureMessage,
} from "./extract";
import { WORK_SUBMIT_DOMAINS } from "./http";
import { kickPanel } from "./panel";
import staticTitles from "./static-titles.json";

/** Mirror of the Troy TROY_ADDRESS pattern: the mailbox is a code constant
 * (lowercased, envelope form) so the gate cannot drift silently. Must match
 * site.config.ts channels.email.mailbox. */
export const TRON_ADDRESS = "tron.netter@ai.xl.net";
const TRON_FROM = "Tron Netter <Tron.Netter@ai.xl.net>";
const SITE = "https://ai.xl.net";

function log(msg: string): void {
  console.log(`[work-email] ${new Date().toISOString()} ${msg}`);
}

function hashKey(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/** Resend send as Tron (sendTroyEmail shape; replies come from the mailbox
 * the submitter actually wrote to). */
async function sendTronEmail(opts: {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    log(`EMAIL SKIPPED (no RESEND_API_KEY): ${opts.subject.slice(0, 80)}`);
    return false;
  }
  const tronTo = [opts.to];
  const bcc = oversightBcc(tronTo);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: TRON_FROM,
        to: tronTo,
        subject: opts.subject,
        text: opts.text,
        // §1 oversight BCC (2026-08-04). This is the lane that most needed it:
        // three of its four call sites reply to an ARBITRARY inbound
        // correspondent with AI-composed prose, and until now no human ever
        // saw a copy of what the persona said to them.
        ...(bcc && { bcc }),
        ...(opts.headers ? { headers: opts.headers } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
      log(`send failed ${res.status}: ${(await res.text()).slice(0, 150)}`);
    return res.ok;
  } catch (err) {
    log(
      `send threw: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`
    );
    return false;
  }
}

/** Throttled WARN to the admin (1/24h per reason class PER SENDER DOMAIN:
 * one client's broken M365 DKIM must not mask every other company's failures
 * for a day, §5.18), never to the unverified sender (approval-inbound
 * warnAdmin pattern, own stamp keys). This WARN doubles as the client
 * DKIM-onboarding signal. */
async function warnAdmin(
  reason: string,
  fromRaw: string,
  subjectRaw: string,
  senderDomain: string
): Promise<void> {
  const stampKey = `work_email_reject_${reason}_${hashKey(senderDomain || "unknown")}`;
  const stamp = await getMeta(stampKey);
  if (stamp && Date.now() - Date.parse(stamp) < 23.5 * 3_600_000) {
    log(`rejected (${reason}); WARN throttled`);
    return;
  }
  const sent = await sendTronEmail({
    to: adminRecipient(),
    subject: `[aiwebsite] WARN work-submission email dropped (${reason}, ${senderDomain || "unknown domain"})`,
    text: [
      `An email to Tron.Netter@ai.xl.net looked like a work submission (registered sender domain + archive attachment) but was dropped without reply.`,
      ``,
      `Reason: ${reason}`,
      `Sender domain: ${senderDomain || "unknown"}`,
      `From: ${sanitizeHeaderValue(fromRaw, 120)}`,
      `Subject: ${sanitizeHeaderValue(subjectRaw, 120)}`,
      ``,
      `Submissions by email only act on DKIM-verified senders at xl.net or a registered roadmap company domain, and never reply to anyone else. If this was a real submitter, have them resend directly from that mailbox (not a forward). A client domain that keeps failing DKIM usually needs its mail system's DKIM records set up (for Microsoft 365: the selector1/selector2 CNAMEs plus enabling DKIM in Defender). This notice repeats at most once per day per reason per domain.`,
    ].join("\n"),
  });
  if (sent) await setMeta(stampKey, new Date().toISOString());
}

// HOSTILE_TITLE_CHARS moved to email-parse.ts (the extracted
// resolveSubjectTitle chain needs it there); imported above for the
// authored-title gate.

function outOfBand(t: string): boolean {
  return t.length < WORK_CAPS.titleMinChars || t.length > WORK_CAPS.titleMaxChars;
}

/** The duplicate-title rejection copy, or null when the title is free. Split
 * out of the admission flow because it now runs at two points: in place for a
 * title resolved from the subject or a body directive, and again the moment a
 * weak title resolves after archive inspection. */
async function titleGuardMessage(
  title: string,
  sender: string,
  scope: WorkScope,
  update?: { exceptId: string }
): Promise<string | null> {
  const isCompany = scope.companyId !== null;
  const trackUrl = isCompany ? `${SITE}/roadmap/work` : `${SITE}/work/submit`;
  const norm = normalizeTitle(title);
  // Hand-authored exhibits are /work-only; company lanes clash only within
  // their own scope (§5.18).
  if (
    (!isCompany &&
      staticTitles.titles.some((t: string) => normalizeTitle(t) === norm)) ||
    (await publishedTitleClash(title, scope, { exceptId: update?.exceptId }))
  )
    return `A published card already uses this title. Pick a different title (the subject line, or a "Title:" line in the body) and resend.`;
  const clash = await activeTitleClash(title, scope);
  if (clash) {
    if (update)
      return clash.submitterEmail === sender
        ? `You already have an update to "${title}" in the pipeline (status: ${clash.status}). Check it at ${SITE}/work/submit. Removing a submission is admin-only, so ask Adam to clear it if you want to replace it with this version.`
        : `A teammate already has an update to "${title}" in review. Only one update per card can be open at a time, so check with them or wait until theirs is decided.`;
    return clash.submitterEmail === sender
      ? isCompany
        ? `You already have a submission titled "${title}" in the pipeline (status: ${clash.status}). Check it at ${trackUrl}.`
        : `You already have a submission titled "${title}" in the pipeline (status: ${clash.status}). Check it at ${SITE}/work/submit. Removing a submission is admin-only, so ask Adam to clear it if you want to resubmit under this title.`
      : `A teammate already has a submission titled "${title}" in review. Pick a different title, or check with them before resubmitting.`;
  }
  return null;
}

/** Byte-identical to the brainHealthy rejection above: an inference that could
 * not run is an outage, and must never be reported to a submitter as "I could
 * not find a name in your email". */
const PIPELINE_OFFLINE =
  "The review pipeline is briefly offline, so nothing was accepted. Resend this email shortly.";

/** The hourly limit on reading a name out of a message. Names the
 * deterministic fix instead of promising recovery, because resending shortly
 * hits the same wall for up to an hour. */
const TITLE_THROTTLED = [
  `You have sent several submissions without a subject line in the last hour, and reading the name out of the message is limited to a few per hour. Nothing was stored. Everything else about your email was fine.`,
  ``,
  `Name this one yourself and it goes straight through: put the name in the subject line, or add a line like "Title: Patching Visualizer" to the body. Then resend.`,
].join("\n");

/** The reply that replaces the form-validation lecture the owner received.
 * Branches on WHY the subject was unusable, because "you had no subject" and
 * "your subject was 118 characters" need different fixes. */
function noTitleMessage(subjectRaw: string, subjectStripped: string): string {
  const example = `Name: Patching Visualizer`;
  const tail = `Everything else about your email was fine.`;
  if (subjectStripped.length > WORK_CAPS.titleMaxChars)
    return [
      `The usable part of your subject line runs to ${subjectStripped.length} characters and a card title has to be ${WORK_CAPS.titleMinChars} to ${WORK_CAPS.titleMaxChars}, so I looked through your message for a shorter name and could not settle on one. ${tail}`,
      ``,
      `Resend with a shorter subject, or put a line like "Title: Patching Visualizer" at the top of the body.`,
    ].join("\n");
  // Mirrors subjectUsable: a forwarded placeholder ("Fwd: (no subject)") is
  // inside the length band, so without the second check this branch told the
  // submitter their 12-character subject was too short and to lengthen it.
  if (
    subjectStripped.length > 0 &&
    !isPlaceholderSubject(subjectRaw) &&
    !isPlaceholderSubject(subjectStripped)
  )
    return [
      `Your subject line came out as "${subjectStripped.slice(0, 80)}", and a card title has to be ${WORK_CAPS.titleMinChars} to ${WORK_CAPS.titleMaxChars} characters. I looked through your message for the name of the tool as well and could not settle on one. ${tail}`,
      ``,
      `Give it a longer subject, or start the body with a line like "${example}", or put a "Title:" line in the body. Then resend.`,
    ].join("\n");
  return [
    `This email had no usable subject line, so I looked through your message for the name of the tool and could not settle on one. ${tail}`,
    ``,
    `Name it either way you like: put the name in the subject line, or start the body with a line like "${example}". A "Title:" line anywhere in the body works too. Then resend.`,
  ].join("\n");
}

function adminRecipient(): string {
  return (
    (process.env.ADMIN_EMAIL || "").split(",")[0]?.trim() || "adam@xl.net"
  );
}

// ---- Hook adapter + handler ----

interface FetchedInbound {
  from: string;
  subject: string;
  text: string | null;
  headers: Record<string, string> | null;
  message_id: string;
  attachments: { id: string; filename: string | null; size: number }[];
}

/**
 * onInbound branch (site.config.ts): decide fast whether this inbound is a
 * work submission. Cheap header checks first; the ONE receiving.get (needed
 * because the hook context carries no attachment info) runs only for
 * xl.net-sender mail addressed to Tron. Never throws; anything unexpected
 * delegates to the module's normal pipeline.
 */
export async function maybeHandleWorkEmail(
  ctx: InboundEmailHookContext
): Promise<"handled" | "delegate"> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) return "delegate";
    if (!ctx.envelopeRecipients.includes(TRON_ADDRESS)) return "delegate";
    const sender = extractAddress(ctx.email.from);
    const domain = sender.split("@")[1] ?? "";
    const staffLane = WORK_SUBMIT_DOMAINS.includes(domain);
    if (!staffLane) {
      // §5.18 company branch. The claim-time From is spoofable, so this is a
      // HINT only (the handler re-resolves after DKIM); it exists to bound
      // the receiving.get spend to registered domains. The strict parser and
      // the freemail re-check inside companyForDomainRow both apply.
      const strictDomain = emailDomain(sender);
      if (!strictDomain) return "delegate";
      if (!roadmapEnabled(process.env)) return "delegate"; // kill switch:
      // Tron answers conversationally, never a silent drop.
      // Pre-DKIM flood bound, company branch ONLY (staff mail was never
      // bounded pre-DKIM and must stay byte-identical): forged-From spam at
      // a registered domain must not farm receiving.get. Over the cap the
      // mail is DROPPED, not delegated: delegation would convert the
      // fail-closed no-reply posture into conversational replies to the
      // flood, and would let a spoofer route a client's real mail into chat.
      const flood = checkRateLimit(`work:email:detect:${strictDomain}`, {
        windowSec: 3600,
        max: ROADMAP_CAPS.companyEmailDetectPerDomainPerHour,
      });
      if (!flood.allowed) {
        void warnAdmin(
          "detect_flood",
          ctx.email.from ?? "",
          ctx.email.subject ?? "",
          strictDomain
        ).catch(() => undefined);
        log(`detect flood cap hit for ${strictDomain}; dropping`);
        return "handled";
      }
      const company = await companyForDomainRow(strictDomain);
      if (!company) return "delegate";
    }
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(ctx.emailId)) return "delegate";
    const resend = new Resend(key);
    const { data: email, error } = await resend.emails.receiving.get(
      ctx.emailId
    );
    if (error || !email) {
      log(
        `detect fetch failed: ${error?.message?.slice(0, 120) ?? "no data"}; delegating`
      );
      return "delegate";
    }
    const { archives } = pickAttachments(email.attachments ?? []);
    if (archives.length === 0) return "delegate";
    // Bare detached dispatch, NEVER Next after(): the module's webhook route
    // ACKs Svix and detaches (void handleInbound) BEFORE this hook runs, so
    // by now the response has closed. after() registered here would enqueue
    // onto a paused callback queue gated on a close event that already fired
    // (verified against next 16.2.11 after-context.js): the callback never
    // runs, the intake silently dies, and the fallback catch is unreachable
    // because after() does not throw while the ALS store is still
    // propagated (panel blocker finding, 2026-07-31). The consequence, that
    // revalidatePath is silently dropped in this detached context, is
    // handled at the publish step instead (panel.ts revalidateWorkPage:
    // loopback on-demand ISR, request-scope-independent).
    void handleWorkEmail(ctx.emailId, sender, email).catch((err: unknown) =>
      log(
        `handler dispatch failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`
      )
    );
    return "handled";
  } catch (err) {
    log(
      `detect threw: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}; delegating`
    );
    return "delegate";
  }
}

function headerLookup(
  headers: Record<string, string> | null,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers))
    if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** One inbound submission email, already claimed from the module. All
 * failures are logged, never thrown (fire-and-forget from the hook). */
export async function handleWorkEmail(
  emailId: string,
  sender: string,
  email: FetchedInbound
): Promise<void> {
  const fromRaw = email.from ?? "";
  const subjectRaw = email.subject ?? "";
  const senderDomain = emailDomain(sender) ?? sender.split("@")[1] ?? "";

  // Delivery dedupe FIRST (email_id is server-assigned per delivery) so
  // webhook redeliveries process once.
  if (
    !(await claimMetaOnce(`work_email_${hashKey(`eid:${emailId}`)}`, "seen"))
  ) {
    log("duplicate delivery; already processed");
    return;
  }

  // ── Fail-closed sender verification (Troy gate, any xl.net sender) ──
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
      subjectRaw,
      senderDomain
    );
    return;
  }
  const verdict = parseEmailAuthVerdict(headers, sender, siteConfig);
  if (!verdict.authenticated) {
    await warnAdmin(
      `auth_${verdict.reason ?? "failed"}`,
      fromRaw,
      subjectRaw,
      senderDomain
    );
    return;
  }
  if (!isFreshDate(headerLookup(headers, "date"), Date.now())) {
    await warnAdmin("stale_or_missing_date", fromRaw, subjectRaw, senderDomain);
    return;
  }
  const messageId = email.message_id || "";
  if (
    messageId &&
    !(await claimMetaOnce(`work_email_${hashKey(`mid:${messageId}`)}`, "seen"))
  ) {
    log("duplicate message_id; already processed");
    return;
  }

  // ── Lane resolution from the VERIFIED sender domain (§5.18) ─────────
  // Always the From-address domain through the strict parser, NEVER the
  // DKIM header.d (resolving on d= would route a subsidiary's mail into a
  // parent tenant). xl.net = staff lane, byte-identical behavior; a
  // registered active company = that company's private lane.
  const staffLane =
    senderDomain !== "" && WORK_SUBMIT_DOMAINS.includes(senderDomain);
  let company: CompanyRow | null = null;
  if (!staffLane) {
    // Company-lane strict alignment recheck: parseEmailAuthVerdict accepts
    // parent-domain signatures (From corp.client.com, d=client.com), which
    // is fine for one fixed staff domain but crosses the exact-label tenancy
    // rule here. Require a dkim=pass whose header.d equals the From domain
    // exactly; anything else is treated as unverified (no reply, WARN).
    const ar = headerLookup(headers, "authentication-results") ?? "";
    const passDomains = [...ar.matchAll(/dkim=pass[^;]*?header\.d=([^\s;]+)/gi)]
      .map((m) => m[1].trim().toLowerCase().replace(/\.$/, ""));
    if (!passDomains.includes(senderDomain)) {
      await warnAdmin("auth_subdomain_alignment", fromRaw, subjectRaw, senderDomain);
      return;
    }
    company = await companyForDomainRow(senderDomain);
    if (!company) {
      // Claimed at detect (a company existed) but gone by verification:
      // verified sender, so one throttled neutral line is safe.
      if (
        checkRateLimit(`work:email:rlnotice:${sender}`, {
          windowSec: 3600,
          max: 1,
        }).allowed
      )
        await sendTronEmail({
          to: sender,
          subject: `Re: ${sanitizeHeaderValue(subjectRaw, 150) || "Your submission"}`,
          text: `Email submissions are not set up for your organization right now. Nothing was stored.\n\n${tronSignature()}`,
        });
      return;
    }
  }
  const isCompanyLane = company !== null;

  // Verified sender from here on: every rejection replies with the fix.
  const replyHeaders: Record<string, string> = {};
  if (messageId) {
    const clean = sanitizeHeaderValue(messageId, 250);
    replyHeaders["In-Reply-To"] = clean;
    replyHeaders["References"] = clean;
  }
  const replySubject = `Re: ${sanitizeHeaderValue(subjectRaw, 150) || (isCompanyLane ? "Your work submission" : "Your /work submission")}`;
  // §5.18: a per-company hourly bound on OUTBOUND replies, checked before
  // every company-lane send (a compromised org rotating senders must not
  // become a reply flood; each fresh sender would otherwise earn its own
  // rlnotice budget). Over the bound: log and go silent.
  const companyReplyAllowed = (): boolean => {
    if (!company) return true;
    const ok = checkRateLimit(`work:email:companyreply:${company.id}`, {
      windowSec: 3600,
      max: ROADMAP_CAPS.companyEmailRepliesPerHour,
    }).allowed;
    if (!ok) log(`company reply bound hit for ${company.id}; going silent`);
    return ok;
  };
  // Rejection shape (2026-08-03 natural-email round): preamble, the ONE
  // targeted fix, an optional one-line form pointer, and Tron's full
  // signature (owner ruling: the normal signature is in ALL emails Tron
  // sends). pointer: false on wait-class rejects (paused, throttled, quota,
  // pipeline offline) where the form hits the same wall, and on update-path
  // rejects whose fix is email-specific.
  const companyPointer = `You can also submit on the web: sign in at ${SITE}/roadmap/work with your work email.`;
  const reject = async (
    message: string,
    opts?: { pointer?: boolean }
  ): Promise<void> => {
    if (!companyReplyAllowed()) return;
    await sendTronEmail({
      to: sender,
      subject: replySubject,
      headers: replyHeaders,
      text: [
        isCompanyLane
          ? `I could not accept this as a work submission. Nothing was stored.`
          : `I could not accept this as a /work submission. Nothing was stored.`,
        ``,
        message,
        ...(opts?.pointer === false
          ? []
          : [``, isCompanyLane ? companyPointer : FORM_POINTER]),
        ``,
        tronSignature(),
      ].join("\n"),
    });
  };

  // ── Admission, in the route's order ──────────────────────────────
  // §5.18: suspended company / roadmap kill switch, neutral + throttled.
  if (isCompanyLane && (company!.status !== "active" || !roadmapEnabled(process.env))) {
    if (
      checkRateLimit(`work:email:rlnotice:${sender}`, {
        windowSec: 3600,
        max: 1,
      }).allowed
    )
      await reject(
        "Email submissions are paused for your organization right now. Nothing was stored. Your company admin can contact XL.net.",
        { pointer: false }
      );
    else log("company paused; notice throttled");
    return;
  }
  if (!workSubmissionsEnabled(process.env)) {
    // Route-order parity keeps the kill switch first, but the route's paused
    // response is a free 503 while this one is an outbound email: cap the
    // notice at 1/hr/sender so a mail loop against a paused pipeline cannot
    // become a reply flood (panel security finding, 2026-07-30).
    if (
      checkRateLimit(`work:email:rlnotice:${sender}`, {
        windowSec: 3600,
        max: 1,
      }).allowed
    )
      await reject(
        "Submissions are paused right now. Published cards are unaffected. Try again later.",
        { pointer: false }
      );
    else log("paused; notice throttled");
    return;
  }
  const attempts = checkRateLimit(`work:submit:email:${sender}`, {
    windowSec: 3600,
    max: isCompanyLane
      ? ROADMAP_CAPS.clientUploadAttemptsPerUserPerHour
      : WORK_CAPS.uploadAttemptsPerUserPerHour,
  });
  if (!attempts.allowed) {
    // One notice per hour per sender: a flood must not become a reply flood.
    if (checkRateLimit(`work:email:rlnotice:${sender}`, { windowSec: 3600, max: 1 }).allowed)
      await reject(
        "Too many submission attempts this hour. Give it a moment and resend.",
        { pointer: false }
      );
    else log("rate limited; notice throttled");
    return;
  }
  // isAdmin elevation is staff-lane-only: an emailed admin identity at a
  // client domain is a DKIM-valid but meaningless coincidence.
  const dailyQuota = isCompanyLane
    ? ROADMAP_CAPS.clientSubmissionsPerUserPerDay
    : isAdmin(sender)
      ? WORK_CAPS.submissionsPerAdminPerDay
      : WORK_CAPS.submissionsPerUserPerDay;
  if ((await countCreatedToday(sender)) >= dailyQuota) {
    await reject(
      `The limit is ${dailyQuota} submissions per person per day (failed submissions do not count). Try again tomorrow.`,
      { pointer: false }
    );
    return;
  }
  if (
    isCompanyLane &&
    (await countCreatedTodayForCompany(company!.id)) >=
      ROADMAP_CAPS.companySubmissionsPerDay
  ) {
    await reject(
      `Your company reached its ${ROADMAP_CAPS.companySubmissionsPerDay} submissions for today (failed submissions do not count). Try again tomorrow.`,
      { pointer: false }
    );
    return;
  }
  if (!(await brainHealthy())) {
    await reject(PIPELINE_OFFLINE, { pointer: false });
    return;
  }

  // ── Fields ───────────────────────────────────────────────────────
  const parsed = parseSubmissionBody(email.text ?? "");
  // Receipt notes (2026-08-03 natural-email round): everything the intake
  // adapted instead of bouncing is disclosed here, between the receipt body
  // and the signature.
  const notes: string[] = [];
  // An explicit "Title:"/"Skill Name:" body line beats the subject:
  // forwarded skill emails arrive with subjects like "Fwd: skill to our
  // work" while the body names the tool (owner report 2026-07-31, the
  // first real submission published under its subject line).
  const authoredRaw =
    parsed.title !== null ? sanitizeHeaderValue(parsed.title, 200).trim() : null;
  // Machine-name echo strip (2026-08-04 incident: "Entra/M365 Security
  // Analyzer (entra-m365-security-analyzer)" published verbatim). Stripping
  // an AUTHORED title is legal here and only here because nameKey-proven
  // self-duplication is not a rename: the update lane already ignores an
  // authored Title: line on exactly this equality ("equal is redundant"),
  // and the surviving head is a verbatim span of the submitter's own words
  // (selection, not authoring). Runs BEFORE the update block so an update's
  // "Title: X (x-slug)" line compares equal to the predecessor instead of
  // bouncing on the rename message, and before the band gate so an over-60
  // composite with a clean head is rescued instead of lectured. Disclosed
  // via an "Also:" receipt note once the title resolves.
  const authoredTitle = authoredRaw !== null ? stripMachineEcho(authoredRaw) : null;

  // ── §5.16 update intent (admin-mediated updates, 2026-08-03) ─────
  // A strong "Update Card:" body directive, or an "Update: <title>" subject
  // (separator required), marks this as a proposed REPLACEMENT of a
  // published card. Resolution runs AFTER the fail-closed DKIM and
  // admission gates above, BEFORE any download: an unresolvable directive
  // rejects loudly and NEVER falls through to a create (a silent conversion
  // in either direction is the refutation FATAL class). Everything an
  // update produces still stops at pending_approval; nothing on this path
  // can swap a live card.
  const subjectUpdateMatch = UPDATE_SUBJECT_RE.exec(
    titleFromSubject(subjectRaw)
  );
  // Update targets are lookup keys, never authored titles, so the
  // machine-echo strip is safe here and keeps the lanes consistent:
  // "Update: Outage Checker (outage-checker)" must resolve to the card the
  // predecessor published as, not bounce on a name no card carries
  // (refutation finding 2026-08-04).
  const updateValueRaw =
    parsed.updateTarget ??
    (subjectUpdateMatch ? subjectUpdateMatch[1].trim() : null);
  const updateValue =
    updateValueRaw !== null ? stripMachineEcho(updateValueRaw) : null;
  let predecessor: SubmissionRow | null = null;
  // §5.18: the update lane is staff-only in v1 (the approval half is
  // xl.net-admin-shaped, and the 0035 CHECK forbids company update rows).
  // A company-lane update directive rejects LOUDLY; silent update->create
  // conversion stays the FATAL class it is.
  if (updateValue !== null && isCompanyLane) {
    await reject(
      `Updating a published card by email is not available for company submissions yet. To ship a new version, submit it as a new card under a different title, or ask XL.net to remove the old card first.`,
      { pointer: false }
    );
    return;
  }
  if (updateValue !== null) {
    const normVal = normalizeTitle(updateValue);
    if (staticTitles.titles.some((t: string) => normalizeTitle(t) === normVal)) {
      await reject(
        `"${updateValue.slice(0, 80)}" is one of the hand-authored cards on /work, and those do not change through submissions. Ask Adam to change that card directly.`,
        { pointer: false }
      );
      return;
    }
    predecessor = await resolveUpdateTarget(updateValue, { companyId: null });
    if (!predecessor) {
      await reject(
        `I could not match "${updateValue.slice(0, 80)}" to a published card on ${SITE}/work. To update a card, copy its exact title from that page into the "Update Card:" line and resend. If you meant to submit a brand new tool, remove that line and resend.`,
        { pointer: false }
      );
      return;
    }
    // Ownership before any download or inspection: the predecessor's
    // submitter, or an admin submitting on a colleague's behalf. The
    // rejection never echoes the owner's address (not public).
    if (
      predecessor.submitterEmail.toLowerCase() !== sender.toLowerCase() &&
      !isAdmin(sender)
    ) {
      await reject(
        `Updates to a published card are accepted from the person who submitted it, or from Adam. Ask them to send the update, or ask Adam to submit it for you.`,
        { pointer: false }
      );
      return;
    }
    // Updates never rename: a differing Title: line is a conflict, an
    // equal one is redundant and ignored (renames stay admin-CLI-only).
    if (
      authoredTitle !== null &&
      nameKey(authoredTitle) !== nameKey(predecessor.title)
    ) {
      await reject(
        `An update keeps the published card's title, and renaming a card is admin only. Remove the "Title:" line and resend, or ask Adam if the card should be renamed.`,
        { pointer: false }
      );
      return;
    }
    // Kind is pinned too; an explicit conflicting Kind: line rejects now,
    // attachment-shape conflicts reject after the attachments are known.
    if (parsed.kind !== null && parsed.kind !== predecessor.kind) {
      await reject(
        `The published card "${predecessor.title}" is a ${predecessor.kind === "skill" ? "CoWork Skill" : "Code program"}, so an update to it must be one too. Attach the matching package type and resend.`,
        { pointer: false }
      );
      return;
    }
  }
  const isUpdate = predecessor !== null;
  // Category prefixes ("Claude Skill: X") duplicate the card's badge. An
  // AUTHORED title (the body line) is the submitter's choice, so it is
  // rejected with instructions, never silently rewritten; a subject-derived
  // title is a transport artifact and is silently stripped (2026-07-31
  // incident: "Claude Skill: Slack Knowledge Assistant" published verbatim).
  // On an update the title is pinned to the predecessor and any authored
  // line was already handled above (equal ignored, differing rejected), so
  // the authored-title shape gates are create-path only.
  if (!isUpdate && authoredTitle !== null && TITLE_KIND_PREFIX_RE.test(authoredTitle)) {
    await reject(
      `The title should be just the tool's name; the card's badge already shows the kind. Remove the category prefix from your title line ("${authoredTitle.slice(0, 80)}") and resend.`
    );
    return;
  }
  // Characters that would break out of the quoting in a downstream prompt or
  // read as markup. An AUTHORED title is rejected with instructions (house
  // rule: never silently rewrite the submitter's choice); a subject is a
  // transport surface and is stripped silently.
  if (!isUpdate && authoredTitle !== null && HOSTILE_TITLE_CHARS.test(authoredTitle)) {
    await reject(
      `A card title cannot contain quotation marks, angle brackets, braces, backticks, or backslashes. Yours was "${authoredTitle.slice(0, 80)}". Take those out of your title line and resend.`
    );
    return;
  }
  if (!isUpdate && authoredTitle !== null && outOfBand(authoredTitle)) {
    await reject(
      `The title line in the body ("Title:", "Skill Name:", and similar) becomes the card title, and it must be ${WORK_CAPS.titleMinChars} to ${WORK_CAPS.titleMaxChars} characters. Yours came out as "${authoredTitle.slice(0, 80)}". Fix that one line and resend.`
    );
    return;
  }
  // The full chain (hostile chars before the kind-prefix strip, machine-echo
  // strip interleaved, whitespace recollapsed last) lives in
  // resolveSubjectTitle so tests pin the ORDER; see its doc comment for the
  // 2026-07-31 ordering lesson. echoStripped drives the receipt disclosure
  // below when the subject wins the title.
  const { title: subjectStripped, echoStripped: subjectEchoStripped } =
    resolveSubjectTitle(subjectRaw);
  // isPlaceholderSubject runs against BOTH the raw header and the
  // transport-stripped value: real forwards arrive as "Fwd: (no subject)" and
  // only reduce to the bare placeholder after titleFromSubject.
  const subjectUsable =
    !isPlaceholderSubject(subjectRaw) &&
    !isPlaceholderSubject(subjectStripped) &&
    !outOfBand(subjectStripped);
  // §5.16 updates: a BODY-directive update whose subject names a different
  // tool is the pasted-release-notes shape (an "Update Card:" line inside
  // quoted prose converting an intended create; refutation F2). The padded
  // nameKey containment lets ordinary descriptive subjects through
  // ("Outage Checker v2 update" contains "outage checker") while a
  // different tool's name rejects loudly instead of converting silently.
  if (
    isUpdate &&
    parsed.updateTarget !== null &&
    subjectUsable &&
    !` ${nameKey(subjectStripped)} `.includes(` ${nameKey(predecessor!.title)} `)
  ) {
    await reject(
      `Your subject line ("${subjectStripped.slice(0, 80)}") names something other than the card your "Update Card:" line points at ("${predecessor!.title}"). If this is an update to that card, make the subject mention it (or start the subject with "Update: ${predecessor!.title}") and resend. If this is a brand new tool, remove the "Update Card:" line and resend.`,
      { pointer: false }
    );
    return;
  }
  // An unusable subject no longer rejects on its own: it falls through to the
  // weak-candidate rungs below (owner directive 2026-07-31). null here means
  // "not resolved yet", never "the submission is bad". On an update the
  // title is PINNED to the predecessor: the ladder never runs.
  let title: string | null = isUpdate
    ? predecessor!.title
    : (authoredTitle ?? (subjectUsable ? subjectStripped : null));
  let titleSource: "authored" | "subject" | "corroborated" | "inferred" =
    authoredTitle !== null || isUpdate ? "authored" : "subject";
  // Disclose the machine-echo strip whenever the adapted value actually
  // became the title (2026-08-03 rule: everything the intake adapted instead
  // of bouncing is disclosed). A discarded subject gets no note, matching
  // how discarded subjects are treated everywhere else.
  if (
    !isUpdate &&
    title !== null &&
    ((titleSource === "authored" && authoredTitle !== authoredRaw) ||
      (titleSource === "subject" && subjectEchoStripped))
  )
    notes.push(
      sender.toLowerCase() === adminRecipient().toLowerCase()
        ? `Also: the title ended by repeating the same name in parentheses, so I dropped the repeat and the card is titled "${title.slice(0, 80)}". Renaming is admin-only, so it is yours to change once the card publishes.`
        : isCompanyLane
          ? `Also: the title ended by repeating the same name in parentheses, so I dropped the repeat and the card is titled "${title.slice(0, 80)}". If it should be called something else, reply to this email and the XL.net team can retitle the card once it publishes.`
          : `Also: the title ended by repeating the same name in parentheses, so I dropped the repeat and the card is titled "${title.slice(0, 80)}". If it should be called something else, tell Adam and he can retitle the card once it publishes.`
    );
  // Natural-email band (2026-08-03): the body is stored VERBATIM as the
  // description (context-only; the card is written from the documents), so
  // only an extreme length rejects. Everything else is accepted with a
  // receipt note; the panel prompt slices at blurbPromptMaxChars.
  if (parsed.blurb.length > WORK_CAPS.emailBlurbMaxChars) {
    await reject(
      `The email body becomes the stored description, and by email up to ${WORK_CAPS.emailBlurbMaxChars} characters are kept. Yours came out at ${parsed.blurb.length} characters after quoted history, signatures, and directive lines were stripped. Tighten it and resend; the panel writes the card from your attached documents either way, so a few paragraphs are plenty.`,
      { pointer: false }
    );
    return;
  }
  if (parsed.blurb.length > WORK_CAPS.blurbMaxChars)
    notes.push(
      `Also: your description came out at ${parsed.blurb.length} characters. The web form caps descriptions at 900, but by email I kept your full text with the submission; the panel writes the card from your attached documents either way.`
    );
  else if (parsed.blurb.length === 0)
    notes.push(
      `Also: this email had no description in the body, so the panel works entirely from the attached documents.`
    );
  else if (parsed.blurb.length < WORK_CAPS.blurbMinChars)
    notes.push(
      `Also: the body carried only a short note, so the panel leans on the attached documents for the card.`
    );
  if (parsed.kindRaw !== null)
    notes.push(
      `Also: I could not read your "Kind:" line ("${parsed.kindRaw}") as "CoWork Skill" or "Code program", so the attachments decided the kind. The line stayed in your description.`
    );
  if (parsed.kindInferred !== null && parsed.kind !== null)
    notes.push(
      `Also: I read your "Kind:" line ("${parsed.kindInferred}") as ${parsed.kind === "skill" ? "CoWork Skill" : "Code program"}. The line stayed in your description.`
    );
  if (parsed.creditIgnored !== null)
    notes.push(
      isCompanyLane
        ? `Also: I read your "Credit:" line ("${parsed.creditIgnored}") as part of the description, not as a credit; a credit is a single first name, so the card carries your company's team credit. If it should carry a personal credit, reply to this email.`
        : `Also: I read your "Credit:" line ("${parsed.creditIgnored}") as part of the description, not as a public credit; a public credit is a single first name, so the card credits the XL.net team. If it should carry a personal credit, tell Adam.`
    );
  // The parser lifts only accept-shaped credits (CREDIT_RE), so an email
  // Credit: line can never bounce a submission; prose values landed in
  // creditIgnored above.
  const attribution: string | null = parsed.credit;

  // ── Attachments ──────────────────────────────────────────────────
  const { archives, mds } = pickAttachments(email.attachments ?? []);
  if (archives.length !== 1) {
    const names = archives
      .slice(0, 5)
      .map((a) => `"${sanitizeHeaderValue(a.filename ?? "unnamed", 60)}"`)
      .join(", ");
    await reject(
      archives.length === 0
        ? `Attach ONE package (.skill or .zip) and resend.`
        : `I need exactly ONE package attachment (.skill or .zip) so there is no doubt what gets reviewed, and this email carries ${archives.length}: ${names}. If the extras are samples or data, fold them into the one package; if they are separate tools, send one email per tool.`
    );
    return;
  }
  const pkg = archives[0];
  const pkgName = pkg.filename ?? "upload.zip";
  // §5.16 updates: kind is pinned to the predecessor; an attachment shape
  // that cannot be that kind (a .skill/.ski or standalone .md on a Code
  // program card) is a conflict, not an override. A bare .zip is valid for
  // both kinds and inherits the pin.
  if (
    isUpdate &&
    predecessor!.kind === "program" &&
    (/\.(skill|ski)$/i.test(pkgName) || mds.length > 0)
  ) {
    await reject(
      `The published card "${predecessor!.title}" is a Code program, so an update to it must be one too. Attach the matching package type (.zip with its architecture doc) and resend.`,
      { pointer: false }
    );
    return;
  }
  const kind = isUpdate
    ? (predecessor!.kind as WorkKind)
    : inferKind(pkgName, mds.length > 0, parsed.kind);
  if (pkg.size > WORK_CAPS.uploadMaxBytes) {
    await reject(
      `That package is too large (limit ${Math.floor(WORK_CAPS.uploadMaxBytes / 1_000_000)} MB).`
    );
    return;
  }
  let mdAtt: AttachmentMeta | null = null;
  if (kind === "skill" && mds.length > 0) {
    const picked = pickSkillDoc(mds);
    if (!picked) {
      const list = mds
        .slice(0, 5)
        .map((m) => `"${sanitizeHeaderValue(m.filename ?? "unnamed", 60)}"`)
        .join(", ");
      await reject(
        `Several .md attachments could be the Skill's document (${list}) and none is named SKILL.md. Attach exactly one, or rename the right one to SKILL.md, and resend.`
      );
      return;
    }
    mdAtt = picked.pick;
    if (picked.noted)
      notes.push(
        `Also: several .md files were attached; I used "${sanitizeHeaderValue(mdAtt.filename ?? "SKILL.md", 60)}" as the Skill's document.`
      );
    if (mdAtt.size > WORK_CAPS.skillMdMaxBytes) {
      await reject("The SKILL.md attachment is too large (limit 1 MB).");
      return;
    }
  }

  // ── Duplicate-title guard (route parity) ─────────────────────────
  // Runs HERE for an already-resolved title, so a clash still costs no
  // download; a weakly-resolved title cannot exist yet and is guarded a
  // second time the moment it resolves, below. An update carries its
  // predecessor's pinned title, which must not clash against the
  // predecessor itself (exceptId); the active-row check then catches a
  // second in-flight update to the same card.
  if (title !== null) {
    const dup = await titleGuardMessage(
      title,
      sender,
      { companyId: company?.id ?? null },
      isUpdate ? { exceptId: predecessor!.id } : undefined
    );
    if (dup) {
      await reject(dup);
      return;
    }
  }

  // ── Download the originals (signed-URL endpoint; bytes stay in memory,
  // route parity: never written to disk) ───────────────────────────
  const bytes = await downloadAttachment(emailId, pkg.id, WORK_CAPS.uploadMaxBytes);
  if (!bytes) {
    await reject(
      "I could not download the package attachment. Resend the email."
    );
    return;
  }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    await reject(
      "That package is not a zip archive. Export a plain .zip and resend."
    );
    return;
  }
  let mdFile: { name: string; bytes: Buffer } | null = null;
  if (mdAtt) {
    const mdBytes = await downloadAttachment(
      emailId,
      mdAtt.id,
      WORK_CAPS.skillMdMaxBytes
    );
    if (!mdBytes) {
      await reject(
        "I could not download the .md attachment. Resend the email."
      );
      return;
    }
    mdFile = { name: mdAtt.filename ?? "SKILL.md", bytes: mdBytes };
  }

  // ── Inspection (route parity: hard failures are NEVER rescued by a
  // clean standalone .md) ──────────────────────────────────────────
  const extracted = await inspectArchive(bytes, kind);
  if (!extracted.ok) {
    await reject(
      extracted.code === "missing_architecture_doc" ||
        (extracted.code === "doc_too_short" && kind === "program")
        ? `${extracted.message}\n\n${MISSING_ARCH_DOC_MESSAGE}`
        : [
            extracted.message,
            ...(extracted.paths?.length
              ? [``, `Files: ${extracted.paths.slice(0, 20).join(", ")}`]
              : []),
          ].join("\n")
    );
    return;
  }
  let docText = extracted.docText;
  let corpus = extracted.corpus;
  let mdMeta:
    | { name: string; sha256: string; bytes: number; data: Buffer }
    | undefined;
  if (kind === "skill") {
    if (mdFile) {
      const mdExtract = inspectBareMd(mdFile.name, mdFile.bytes);
      if (!mdExtract.ok) {
        await reject(mdExtract.message);
        return;
      }
      docText = mdExtract.docText;
      corpus = mergeSkillCorpus(mdExtract, extracted);
      mdMeta = {
        name: mdFile.name.slice(0, 200),
        sha256: mdExtract.archiveSha256,
        bytes: mdFile.bytes.length,
        data: mdFile.bytes,
      };
    } else if (extracted.docMissing) {
      // Carry the candidate paths the route's 422 body ships, so an email
      // submitter learns which files collided (panel parity finding).
      await reject(
        [
          skillDocFailureMessage(extracted.docMissing),
          ...(extracted.candidatePaths?.length
            ? [
                ``,
                `Files: ${extracted.candidatePaths.slice(0, 20).join(", ")}`,
              ]
            : []),
        ].join("\n")
      );
      return;
    } else if (extracted.docRawBytes) {
      const docBase =
        extracted.docPath.split("!/").pop()?.split("/").pop() ?? "SKILL.md";
      mdMeta = {
        name: docBase.slice(0, 200),
        sha256: crypto
          .createHash("sha256")
          .update(extracted.docRawBytes)
          .digest("hex"),
        bytes: extracted.docRawBytes.length,
        data: extracted.docRawBytes,
      };
    }
  }

  // ── Weak title resolution ────────────────────────────────────────
  // Deliberately placed HERE, after inspectArchive and after the skill/md
  // branch finalizes docText (a standalone SKILL.md only lands above), and
  // after the blurb, credit and attachment gates. So no brain budget is ever
  // spent on a submission about to fail on "not a zip", a missing
  // architecture doc, the secret scan, or the attachment count; docText is
  // available to corroborate at zero cost; and the rejection copy can
  // honestly say everything else about the email was fine. That sentence is
  // load-bearing on this ordering.
  if (title === null) {
    const senderTokens = senderIdentityTokens(fromRaw, sender);
    const candidates = parsed.titleCandidates.filter(
      (c) => !isSenderIdentity(c.value, senderTokens)
    );
    const declared = [
      ...docDeclaredNames(docText),
      ...archiveDeclaredNames(
        pkgName,
        extracted.manifest.map((m) => m.path)
      ),
    ].map(nameKey);
    // A corroborated candidate clears the SAME gate a model answer does
    // (house rules, hostile characters, sender identity); a candidate that
    // fails falls through to the brain rung rather than being rewritten.
    const hit = candidates
      .filter((c) => declared.includes(nameKey(c.value)))
      .map((c) => validateWeakTitle(c.value, senderTokens))
      .find((r) => r.ok);
    if (hit && hit.ok) {
      // The submitter's own package corroborates the name. No brain call.
      title = hit.title;
      titleSource = "corroborated";
    } else {
      // §5.18 company lane: title inference burns a real brain call that
      // creates NO row, so the per-submission quotas never see it. Bound it
      // per company per day and against the roadmap ledger's headroom, and
      // mirror the actual call into that ledger (work_usage is debited
      // inside the call as always).
      if (isCompanyLane) {
        const coCap = checkRateLimit(`work:titleinfer:co:${company!.id}`, {
          windowSec: 86_400,
          max: ROADMAP_CAPS.companyTitleInfersPerDay,
        });
        if (!coCap.allowed) {
          await reject(noTitleMessage(subjectRaw, subjectStripped));
          return;
        }
        const usage = await readTodayRoadmapUsage();
        if (usage.brainCalls + 1 > roadmapBrainDailyCap(process.env)) {
          await reject(PIPELINE_OFFLINE, { pointer: false });
          return;
        }
      }
      const got = await inferTitleFromEmail({
        emailId,
        sender,
        fromRaw,
        blurb: parsed.blurb,
        docText,
        kind,
        packageName: pkgName,
      });
      if (isCompanyLane && got.ok) {
        try {
          await recordRoadmapBrainCall();
        } catch {
          // mirror only; never a gate
        }
      }
      if (!got.ok) {
        await reject(
          got.reason === "unavailable"
            ? PIPELINE_OFFLINE
            : got.reason === "throttled"
              ? TITLE_THROTTLED
              : noTitleMessage(subjectRaw, subjectStripped),
          got.reason === "unavailable" ? { pointer: false } : undefined
        );
        return;
      }
      title = got.title;
      titleSource = "inferred";
    }
    log(`title ${titleSource} len=${title.length} by=${hashKey(sender)}`);
    const dup = await titleGuardMessage(title, sender, { companyId: company?.id ?? null });
    if (dup) {
      await reject(dup);
      return;
    }
  }

  // ── Persist + kick (route parity) ────────────────────────────────
  let row;
  try {
    row = await createSubmission({
      companyId: company?.id ?? null,
      userId: await userIdForEmail(sender),
      email: sender,
      name: attribution,
      kind,
      title,
      blurb: parsed.blurb,
      architectureText: kind === "program" ? docText : null,
      skillMdText: kind === "skill" ? docText : null,
      fileManifestJson: JSON.stringify(extracted.manifest),
      corpusFilesJson: JSON.stringify(corpus),
      archiveName: pkgName.slice(0, 200),
      archiveSha256: extracted.archiveSha256,
      archiveBytes: extracted.archiveBytes,
      archiveData: bytes,
      md: mdMeta,
      parentId: predecessor?.id ?? null,
    });
  } catch (err) {
    if (
      isUniqueViolation(
        err,
        "work_sub_active_title_uq",
        "work_sub_parent_active_uq"
      )
    ) {
      await reject(
        isUpdate
          ? `An update to "${title}" is already in the pipeline, and only one can be open at a time. Check ${SITE}/work/submit, or ask Adam to clear the pending one.`
          : `A submission titled "${title}" is already in the pipeline. Check ${isCompanyLane ? `${SITE}/roadmap/work` : `${SITE}/work/submit`}.`,
        isUpdate ? { pointer: false } : undefined
      );
      return;
    }
    log(
      `createSubmission failed: ${err instanceof Error ? err.message.slice(0, 150) : "unknown"}`
    );
    await reject(
      "Something went wrong on my end saving the submission. Resend this email shortly.",
      { pointer: false }
    );
    return;
  }

  let kicked: Awaited<ReturnType<typeof kickPanel>>;
  try {
    kicked = await kickPanel(row.id);
  } catch (err) {
    log(
      `kickPanel threw on ${row.id}: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
    );
    kicked = { outcome: { status: "refused", reason: "claim" } };
  }
  log(
    `accepted ${row.id} kind=${kind} kick=${kicked.outcome.status} by=${hashKey(sender)}`
  );
  // A refused kick leaves the row at "received" and NOTHING re-kicks it
  // automatically; the site path surfaces this as QUEUED_NOTICE with a Retry
  // instruction, so the receipt must too (panel parity finding, 2026-07-30).
  const kindLabel = kind === "skill" ? "CoWork Skill" : "Code program";
  // Update receipts state the approval gate plainly: the live card never
  // changes on this path without the admin's click on /admin/work, whoever
  // sent the mail (isAdmin(sender) only varies the wording, never the gate:
  // an emailed admin identity is a spoofable From under domain DKIM).
  const receipt = isUpdate
    ? kicked.outcome.status === "running"
      ? isAdmin(sender)
        ? [
            `Got it. The update to "${title}" is in review. Updates always wait for your click: when the review finishes, approve it at ${SITE}/admin/work.`,
            ``,
            `The live card stays up until then. Track it at ${SITE}/work/submit.`,
          ]
        : [
            `Got it. Your update to "${title}" is in and the editorial panel is reviewing it now.`,
            ``,
            `The live card stays up while the update is reviewed. If the panel passes it, Adam gets an approval email and the card only changes after he approves the swap. You will get an email at each step. Track it at ${SITE}/work/submit.`,
          ]
      : [
          `Got it. Your update to "${title}" is stored, but the review panel is briefly unavailable, so the review has not started.`,
          ``,
          `Open ${SITE}/work/submit in a few minutes and press Retry to start the review. The live card stays up the whole time, and if the review passes, the swap still waits for Adam's approval.`,
        ]
    : kicked.outcome.status === "running"
      ? isCompanyLane
        ? [
            `Got it. "${title}" is in as a ${kindLabel} submission and the editorial panel is reviewing it now.`,
            ``,
            `If it passes, it publishes to your company's private Your Work page and is credited to you on your company's scorecard, which everyone at ${senderDomain} who signs in can see. You will get an email when the card publishes or is held for review. Track it at ${SITE}/roadmap/work.`,
          ]
        : [
            `Got it. "${title}" is in as a ${kindLabel} submission and the editorial panel is reviewing it now.`,
            ``,
            `You will get an email when the card publishes or is held for review. Track it at ${SITE}/work/submit.`,
          ]
      : isCompanyLane
        ? [
            `Got it. "${title}" is stored as a ${kindLabel} submission, but the review panel is briefly unavailable, so the review has not started.`,
            ``,
            `Sign in at ${SITE}/roadmap/work in a few minutes and press Retry to start the review. Once it runs, you will get an email when the card publishes or is held.`,
          ]
        : [
            `Got it. "${title}" is stored as a ${kindLabel} submission, but the review panel is briefly unavailable, so the review has not started.`,
            ``,
            `Open ${SITE}/work/submit in a few minutes and press Retry to start the review. Once it runs, you will get an email when the card publishes or is held.`,
          ];
  // A title the submitter did not write is disclosed in the receipt, near the
  // top, because renaming and removing are both admin-only. The copy says
  // "once it publishes" and NOT "before the panel finishes": the retitle tool
  // refuses on a row with a live panel heartbeat, and retitling a card is
  // only supported once the row is published, so naming the running window
  // would point at the one moment the lever is blocked (verification
  // finding 2026-07-31). No reply-to-rename lever is promised either, because
  // none exists (an attachment-free reply delegates to the module's ordinary
  // conversation path).
  const disclosure =
    titleSource === "corroborated" || titleSource === "inferred"
      ? sender.toLowerCase() === adminRecipient().toLowerCase()
        ? [
            ``,
            `About that title: this email had no usable subject line, so I took the card name from your message. Renaming and removing are both admin-only, so it is yours to change once the card publishes.`,
          ]
        : isCompanyLane
          ? [
              ``,
              `About that title: your email had no usable subject line, so I took the card name from your message. If it should be called something else, reply to this email and the XL.net team can retitle the card once it publishes.`,
            ]
          : [
              ``,
              `About that title: your email had no usable subject line, so I took the card name from your message. Renaming and removing are both admin-only, so if it should be called something else, tell Adam and he can retitle the card once it publishes.`,
            ]
      : [];
  await sendTronEmail({
    to: sender,
    subject: replySubject,
    headers: replyHeaders,
    text: [
      receipt[0],
      ...disclosure,
      ...receipt.slice(1),
      ...notes.flatMap((n) => [``, n]),
      ``,
      tronSignature(),
    ].join("\n"),
  });
  if (kicked.run) await kicked.run(); // runPanel never throws
}

/** Fetch one attachment through the signed-URL endpoint, hard-capped. */
async function downloadAttachment(
  emailId: string,
  attachmentId: string,
  maxBytes: number
): Promise<Buffer | null> {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.receiving.attachments.get({
      emailId,
      id: attachmentId,
    });
    if (error || !data?.download_url) {
      log(
        `attachment meta failed: ${error?.message?.slice(0, 120) ?? "no url"}`
      );
      return null;
    }
    const res = await fetch(data.download_url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      log(`attachment download failed ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > maxBytes) {
      log(`attachment size out of bounds (${buf.length} bytes)`);
      return null;
    }
    return buf;
  } catch (err) {
    log(
      `attachment download threw: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`
    );
    return null;
  }
}
