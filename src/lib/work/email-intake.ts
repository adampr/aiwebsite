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
} from "./config";
import {
  activeTitleClash,
  countCreatedToday,
  createSubmission,
  normalizeTitle,
  publishedTitleClash,
  userIdForEmail,
} from "./db";
import {
  archiveDeclaredNames,
  docDeclaredNames,
  FORMAT_REMINDER,
  inferKind,
  isPlaceholderSubject,
  isSenderIdentity,
  nameKey,
  parseSubmissionBody,
  pickAttachments,
  senderIdentityTokens,
  stripKindPrefix,
  titleFromSubject,
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
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: TRON_FROM,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
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

/** Throttled WARN to the admin (1/24h per reason class), never to the
 * unverified sender (approval-inbound warnAdmin pattern, own stamp keys). */
async function warnAdmin(
  reason: string,
  fromRaw: string,
  subjectRaw: string
): Promise<void> {
  const stampKey = `work_email_reject_${reason}`;
  const stamp = await getMeta(stampKey);
  if (stamp && Date.now() - Date.parse(stamp) < 23.5 * 3_600_000) {
    log(`rejected (${reason}); WARN throttled`);
    return;
  }
  const sent = await sendTronEmail({
    to: adminRecipient(),
    subject: `[aiwebsite] WARN work-submission email dropped (${reason})`,
    text: [
      `An email to Tron.Netter@ai.xl.net looked like a /work submission (xl.net sender + archive attachment) but was dropped without reply.`,
      ``,
      `Reason: ${reason}`,
      `From: ${sanitizeHeaderValue(fromRaw, 120)}`,
      `Subject: ${sanitizeHeaderValue(subjectRaw, 120)}`,
      ``,
      `Submissions by email only act on DKIM-verified xl.net senders and never reply to anyone else. If this was a real teammate, have them resend from their xl.net mailbox (not a forward); this notice repeats at most once per day per reason.`,
    ].join("\n"),
  });
  if (sent) await setMeta(stampKey, new Date().toISOString());
}

/** Characters that would break out of the quoting in a downstream prompt, or
 * read as markup on the card. A resolved title carrying these is rejected
 * (authored) or stripped (subject-derived) BEFORE the title reaches panel.ts,
 * which additionally JSON-quotes it at every interpolation site. Apostrophes
 * are legal: "Tech's Helper" is a real title. */
const HOSTILE_TITLE_CHARS = /["`<>{}|\\]/;
const HOSTILE_TITLE_CHARS_G = /["`<>{}|\\]/g;

function outOfBand(t: string): boolean {
  return t.length < WORK_CAPS.titleMinChars || t.length > WORK_CAPS.titleMaxChars;
}

/** The duplicate-title rejection copy, or null when the title is free. Split
 * out of the admission flow because it now runs at two points: in place for a
 * title resolved from the subject or a body directive, and again the moment a
 * weak title resolves after archive inspection. */
async function titleGuardMessage(
  title: string,
  sender: string
): Promise<string | null> {
  const norm = normalizeTitle(title);
  if (
    staticTitles.titles.some((t: string) => normalizeTitle(t) === norm) ||
    (await publishedTitleClash(title))
  )
    return `A published /work card already uses this title. Pick a different title (the subject line, or a "Title:" line in the body) and resend.`;
  const clash = await activeTitleClash(title);
  if (clash)
    return clash.submitterEmail === sender
      ? `You already have a submission titled "${title}" in the pipeline (status: ${clash.status}). Check it at ${SITE}/work/submit. Removing a submission is admin-only, so ask Adam to clear it if you want to resubmit under this title.`
      : `A teammate already has a submission titled "${title}" in review. Pick a different title, or check with them before resubmitting.`;
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
    if (!WORK_SUBMIT_DOMAINS.includes(domain)) return "delegate";
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
      subjectRaw
    );
    return;
  }
  const verdict = parseEmailAuthVerdict(headers, sender, siteConfig);
  if (!verdict.authenticated) {
    await warnAdmin(`auth_${verdict.reason ?? "failed"}`, fromRaw, subjectRaw);
    return;
  }
  if (!isFreshDate(headerLookup(headers, "date"), Date.now())) {
    await warnAdmin("stale_or_missing_date", fromRaw, subjectRaw);
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

  // Verified staff from here on: every rejection replies with the fix.
  const replyHeaders: Record<string, string> = {};
  if (messageId) {
    const clean = sanitizeHeaderValue(messageId, 250);
    replyHeaders["In-Reply-To"] = clean;
    replyHeaders["References"] = clean;
  }
  const replySubject = `Re: ${sanitizeHeaderValue(subjectRaw, 150) || "Your /work submission"}`;
  const reject = async (message: string): Promise<void> => {
    await sendTronEmail({
      to: sender,
      subject: replySubject,
      headers: replyHeaders,
      text: [
        `I could not accept this as a /work submission. Nothing was stored.`,
        ``,
        message,
        ``,
        FORMAT_REMINDER,
        ``,
        `- Tron Netter`,
      ].join("\n"),
    });
  };

  // ── Admission, in the route's order ──────────────────────────────
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
        "Submissions are paused right now. Published cards are unaffected. Try again later."
      );
    else log("paused; notice throttled");
    return;
  }
  const attempts = checkRateLimit(`work:submit:email:${sender}`, {
    windowSec: 3600,
    max: WORK_CAPS.uploadAttemptsPerUserPerHour,
  });
  if (!attempts.allowed) {
    // One notice per hour per sender: a flood must not become a reply flood.
    if (checkRateLimit(`work:email:rlnotice:${sender}`, { windowSec: 3600, max: 1 }).allowed)
      await reject("Too many submission attempts this hour. Give it a moment and resend.");
    else log("rate limited; notice throttled");
    return;
  }
  const dailyQuota = isAdmin(sender)
    ? WORK_CAPS.submissionsPerAdminPerDay
    : WORK_CAPS.submissionsPerUserPerDay;
  if ((await countCreatedToday(sender)) >= dailyQuota) {
    await reject(
      `The limit is ${dailyQuota} submissions per person per day (failed submissions do not count). Try again tomorrow.`
    );
    return;
  }
  if (!(await brainHealthy())) {
    await reject(
      "The review pipeline is briefly offline, so nothing was accepted. Resend this email shortly."
    );
    return;
  }

  // ── Fields ───────────────────────────────────────────────────────
  const parsed = parseSubmissionBody(email.text ?? "");
  // An explicit "Title:"/"Skill Name:" body line beats the subject:
  // forwarded skill emails arrive with subjects like "Fwd: skill to our
  // work" while the body names the tool (owner report 2026-07-31, the
  // first real submission published under its subject line).
  const authoredTitle =
    parsed.title !== null ? sanitizeHeaderValue(parsed.title, 200).trim() : null;
  // Category prefixes ("Claude Skill: X") duplicate the card's badge. An
  // AUTHORED title (the body line) is the submitter's choice, so it is
  // rejected with instructions, never silently rewritten; a subject-derived
  // title is a transport artifact and is silently stripped (2026-07-31
  // incident: "Claude Skill: Slack Knowledge Assistant" published verbatim).
  if (authoredTitle !== null && TITLE_KIND_PREFIX_RE.test(authoredTitle)) {
    await reject(
      `The title should be just the tool's name; the card's badge already shows the kind. Remove the category prefix from your title line ("${authoredTitle.slice(0, 80)}") and resend.`
    );
    return;
  }
  // Characters that would break out of the quoting in a downstream prompt or
  // read as markup. An AUTHORED title is rejected with instructions (house
  // rule: never silently rewrite the submitter's choice); a subject is a
  // transport surface and is stripped silently.
  if (authoredTitle !== null && HOSTILE_TITLE_CHARS.test(authoredTitle)) {
    await reject(
      `A card title cannot contain quotation marks, angle brackets, braces, backticks, or backslashes. Yours was "${authoredTitle.slice(0, 80)}". Take those out of your title line and resend.`
    );
    return;
  }
  if (authoredTitle !== null && outOfBand(authoredTitle)) {
    await reject(
      `The title line in the body ("Title:", "Skill Name:", and similar) becomes the card title, and it must be ${WORK_CAPS.titleMinChars} to ${WORK_CAPS.titleMaxChars} characters. Yours came out as "${authoredTitle.slice(0, 80)}". Fix that one line and resend.`
    );
    return;
  }
  // Hostile characters come out BEFORE the kind-prefix strip, or a quoted
  // subject ("Skill: Slack Knowledge Assistant") re-exposes a category prefix
  // that then fails the publish lint after a panel run was already spent
  // (verification finding 2026-07-31). Whitespace is recollapsed last.
  const subjectStripped = stripKindPrefix(
    titleFromSubject(subjectRaw).replace(HOSTILE_TITLE_CHARS_G, "")
  )
    .replace(/\s+/g, " ")
    .trim();
  // isPlaceholderSubject runs against BOTH the raw header and the
  // transport-stripped value: real forwards arrive as "Fwd: (no subject)" and
  // only reduce to the bare placeholder after titleFromSubject.
  const subjectUsable =
    !isPlaceholderSubject(subjectRaw) &&
    !isPlaceholderSubject(subjectStripped) &&
    !outOfBand(subjectStripped);
  // An unusable subject no longer rejects on its own: it falls through to the
  // weak-candidate rungs below (owner directive 2026-07-31). null here means
  // "not resolved yet", never "the submission is bad".
  let title: string | null = authoredTitle ?? (subjectUsable ? subjectStripped : null);
  let titleSource: "authored" | "subject" | "corroborated" | "inferred" =
    authoredTitle !== null ? "authored" : "subject";
  if (parsed.kindRaw !== null) {
    await reject(
      `I did not recognize the kind "${parsed.kindRaw}". Use "Kind: CoWork Skill" or "Kind: Code program", or drop the line to let the attachments decide.`
    );
    return;
  }
  if (
    parsed.blurb.length < WORK_CAPS.blurbMinChars ||
    parsed.blurb.length > WORK_CAPS.blurbMaxChars
  ) {
    await reject(
      `The email body becomes the description, and it must be ${WORK_CAPS.blurbMinChars} to ${WORK_CAPS.blurbMaxChars} characters of plain text: what it does, who uses it, what it replaced. Yours came out at ${parsed.blurb.length} characters (quoted history, signatures, and "Title:"/"Kind:"/"Credit:" lines are stripped automatically).`
    );
    return;
  }
  let attribution: string | null = null;
  if (parsed.credit) {
    if (!/^[A-Za-z][A-Za-z'-]{1,19}$/.test(parsed.credit)) {
      await reject(
        "The public credit must be a single first name, letters only, 2 to 20 characters. Drop the Credit: line to publish as the XL.net team."
      );
      return;
    }
    attribution = parsed.credit;
  }

  // ── Attachments ──────────────────────────────────────────────────
  const { archives, mds } = pickAttachments(email.attachments ?? []);
  if (archives.length !== 1) {
    await reject(
      `Attach exactly ONE package (.skill or .zip); this email carries ${archives.length}.`
    );
    return;
  }
  const pkg = archives[0];
  const pkgName = pkg.filename ?? "upload.zip";
  const kind = inferKind(pkgName, mds.length > 0, parsed.kind);
  if (pkg.size > WORK_CAPS.uploadMaxBytes) {
    await reject(
      `That package is too large (limit ${Math.floor(WORK_CAPS.uploadMaxBytes / 1_000_000)} MB).`
    );
    return;
  }
  let mdAtt: AttachmentMeta | null = null;
  if (kind === "skill" && mds.length > 0) {
    if (mds.length > 1) {
      await reject(
        "Several .md attachments could be the Skill's document. Attach exactly one (the SKILL.md the panel should review)."
      );
      return;
    }
    mdAtt = mds[0];
    if (mdAtt.size > WORK_CAPS.skillMdMaxBytes) {
      await reject("The SKILL.md attachment is too large (limit 1 MB).");
      return;
    }
  }

  // ── Duplicate-title guard (route parity) ─────────────────────────
  // Runs HERE for an already-resolved title, so a clash still costs no
  // download; a weakly-resolved title cannot exist yet and is guarded a
  // second time the moment it resolves, below.
  if (title !== null) {
    const dup = await titleGuardMessage(title, sender);
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
      "I could not download the package attachment. Resend the email, or use the form instead."
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
        "I could not download the .md attachment. Resend the email, or use the form instead."
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
      const got = await inferTitleFromEmail({
        emailId,
        sender,
        fromRaw,
        blurb: parsed.blurb,
        docText,
        kind,
        packageName: pkgName,
      });
      if (!got.ok) {
        await reject(
          got.reason === "unavailable"
            ? PIPELINE_OFFLINE
            : got.reason === "throttled"
              ? TITLE_THROTTLED
              : noTitleMessage(subjectRaw, subjectStripped)
        );
        return;
      }
      title = got.title;
      titleSource = "inferred";
    }
    log(`title ${titleSource} len=${title.length} by=${hashKey(sender)}`);
    const dup = await titleGuardMessage(title, sender);
    if (dup) {
      await reject(dup);
      return;
    }
  }

  // ── Persist + kick (route parity) ────────────────────────────────
  let row;
  try {
    row = await createSubmission({
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
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("work_sub_active_title_uq")
    ) {
      await reject(
        `A submission titled "${title}" is already in the pipeline. Check ${SITE}/work/submit.`
      );
      return;
    }
    log(
      `createSubmission failed: ${err instanceof Error ? err.message.slice(0, 150) : "unknown"}`
    );
    await reject(
      "Something went wrong on my end saving the submission. Resend this email shortly."
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
  const receipt =
    kicked.outcome.status === "running"
      ? [
          `Got it. "${title}" is in as a ${kindLabel} submission and the editorial panel is reviewing it now.`,
          ``,
          `You will get an email when the card publishes or is held for review. Track it at ${SITE}/work/submit.`,
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
        : [
            ``,
            `About that title: your email had no usable subject line, so I took the card name from your message. Renaming and removing are both admin-only, so if it should be called something else, tell Adam and he can retitle the card once it publishes.`,
          ]
      : [];
  await sendTronEmail({
    to: sender,
    subject: replySubject,
    headers: replyHeaders,
    text: [receipt[0], ...disclosure, ...receipt.slice(1), ``, `- Tron Netter`].join(
      "\n"
    ),
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
