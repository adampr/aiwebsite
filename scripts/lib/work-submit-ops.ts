// Pure decision + refusal helpers for the §5.16 scripted submission lane
// (scripts/work-submit.ts, the operator twin of POST /api/work/submissions).
// Deliberately DB-free at call time so scripts/work-submit-tests.ts drives
// every branch with no database, no brain and no network, exactly the way
// scripts/lib/work-transfer-ops.ts backs work:transfer.
//
// NOTHING HERE RE-DERIVES A RULE. Every band, regex, message and ladder step
// is either imported from the route's own modules (WORK_CAPS and
// TITLE_KIND_PREFIX_RE from work/config.ts, splitMachineEcho from
// work/names.ts, parseTimeSavedHours from work/time-saved.ts, normalizeTitle
// from work/db.ts, staticTitles from work/static-titles.json, sameEmail from
// work/transfer.ts, kindVerdictSentence from work/classify.ts, emailDomain
// from rfp/access.ts, WORK_SUBMIT_DOMAINS from work/http.ts, extractAddress
// from governance/approval.ts) or is a VERBATIM copy of a literal that lives
// inside src/app/api/work/submissions/route.ts and is not exported from it.
//
// The copied-literal set is small and named here so a reader can diff it:
// the route's own workError() sentences, plus its four unexported local
// helpers kindRefusal, standaloneDocError, rescuePassError and outerLevelOnly
// (re-expressed below as kindRefusalText, standaloneDocMessage,
// rescuePassMessage and outerLevelOnly). They are unexported route locals, so
// importing them is impossible and the route is not ours to edit this round;
// scripts/work-submit-tests.ts pins each one against the committed route
// source so a wording change there fails the suite here.
//
// SUBMIT_GATES is the route's gate order AS DATA, so the script cannot
// silently reorder or drop one and the tests can assert the sequence.
//
// NO EM DASHES anywhere in this file (site rule); middots are fine.

import { readFileSync } from "node:fs";
import {
  TITLE_KIND_PREFIX_RE,
  WORK_CAPS,
  workSubmissionsEnabled,
} from "../../src/lib/work/config";
import { kindVerdictSentence, type KindVerdict } from "../../src/lib/work/classify";
import { normalizeTitle } from "../../src/lib/work/db";
import type { ExtractErr, ExtractOk } from "../../src/lib/work/extract";
import { WORK_SUBMIT_DOMAINS } from "../../src/lib/work/http";
import { splitMachineEcho } from "../../src/lib/work/names";
import staticTitles from "../../src/lib/work/static-titles.json";
import { sameEmail } from "../../src/lib/work/transfer";
import { extractAddress } from "../../src/lib/governance/approval";
import { emailDomain } from "../../src/lib/rfp/access";

export { workSubmissionsEnabled };

// ── The gate ladder, as data ───────────────────────────────────────

/** Every gate POST /api/work/submissions applies AFTER authentication, in
 * the route's own order, with the committed-file line span each one occupies
 * (git show HEAD:src/app/api/work/submissions/route.ts). The script walks
 * this list in order and prints it under --dry-run; the tests assert the
 * sequence, so a gate cannot be quietly dropped or moved.
 *
 * NOTE the two entries the ROUTE orders differently from how the operator
 * brief listed them: the durable daily quota is the route's THIRD gate, ahead
 * of every title check, and the attribution shape check sits between the
 * title-clash reads and the package checks. The route's order wins: it is
 * what decides which single refusal a submitter sees. */
export type GateId =
  | "kill_switch"
  | "daily_quota"
  | "title_band"
  | "title_kind_prefix"
  | "title_machine_echo"
  | "blurb_max"
  | "time_saved"
  | "published_title_clash"
  | "active_title_clash"
  | "attribution"
  | "package_present"
  | "package_ext"
  | "package_size"
  | "package_bytes"
  | "md_ext"
  | "md_size"
  | "inspect_archive"
  | "standalone_doc"
  | "kind_ladder"
  | "doc_precedence"
  | "unique_violation";

export interface GateSpec {
  id: GateId;
  /** Line span in the committed route file. */
  route: string;
  /** One line an operator can read in the --dry-run ladder. */
  what: string;
}

export const SUBMIT_GATES: readonly GateSpec[] = [
  { id: "kill_switch", route: "219-224", what: "submissions kill switch (WORK_SUBMISSIONS_ENABLED)" },
  { id: "daily_quota", route: "239-249", what: "durable submissions/creator/day (countCreatedToday)" },
  { id: "title_band", route: "298-307", what: "title length band" },
  { id: "title_kind_prefix", route: "311-316", what: "TITLE_KIND_PREFIX_RE (no category prefix)" },
  { id: "title_machine_echo", route: "323-328", what: "machine-name echo in the title" },
  { id: "blurb_max", route: "332-338", what: "description max chars (no minimum)" },
  { id: "time_saved", route: "350-351", what: "time saved per month (parseTimeSavedHours)" },
  { id: "published_title_clash", route: "355-367", what: "static exhibit titles + publishedTitleClash" },
  { id: "active_title_clash", route: "368-381", what: "activeTitleClash" },
  { id: "attribution", route: "385-397", what: "public credit shape (single first name)" },
  { id: "package_present", route: "405-411", what: "a package is attached and non-empty" },
  { id: "package_ext", route: "412-418", what: "package extension .zip or .skill" },
  { id: "package_size", route: "419-424", what: "package size cap (declared size)" },
  { id: "package_bytes", route: "425-427", what: "package size cap (bytes actually read)" },
  { id: "md_ext", route: "445-453", what: "standalone document extension .md/.mdx/.markdown" },
  { id: "md_size", route: "454-459", what: "standalone document 1 MB cap" },
  { id: "inspect_archive", route: "465", what: "inspectArchive(bytes, null): the package walk and kind inference" },
  { id: "standalone_doc", route: "473", what: "inspectBareMd on the standalone document" },
  { id: "kind_ladder", route: "475-543", what: "kind ladder: accept, standalone-document rescue, or hard refusal" },
  { id: "doc_precedence", route: "545-598", what: "reviewed-doc precedence and md_* backfill" },
  { id: "unique_violation", route: "626-638", what: "work_sub_active_title_uq race on insert" },
];

// ── Arguments ──────────────────────────────────────────────────────

export const SUBMIT_USAGE =
  'Usage: npm run work:submit -- --title "<title>" --file <package.zip> ' +
  "[--md <doc.md>] [--blurb-file <file>] [--email adam@xl.net] " +
  "[--attribution <FirstName>] [--time-saved <hours>] [--dry-run] [--yes]";

export type SubmitArgs = {
  title: string;
  file: string;
  md: string | null;
  blurbFile: string | null;
  /** As typed; null means "default to the first ADMIN_EMAIL entry". */
  email: string | null;
  attribution: string | null;
  /** Raw, handed to parseTimeSavedHours unchanged (null = field absent, the
   * same thing form.get() returns when the web form omits it). */
  timeSaved: string | null;
  dryRun: boolean;
  yes: boolean;
};

export type SubmitArgsParse =
  | { ok: true; args: SubmitArgs }
  | { ok: false; error: string };

const VALUE_FLAGS = new Set([
  "--title",
  "--file",
  "--md",
  "--blurb-file",
  "--email",
  "--attribution",
  "--time-saved",
]);

/**
 * `--title "<title>" --file <package> [--md <doc.md>] [--blurb-file <file>]
 *  [--email <addr>] [--attribution <FirstName>] [--time-saved <hours>]
 *  [--dry-run] [--yes]`.
 *
 * Loud on every shape error, and no positional arguments at all: a bare word
 * on this command line is almost always a title that lost its quotes, and
 * silently ignoring it would file a submission under the wrong name. Repeated
 * flags are refused rather than last-wins for the same reason.
 */
export function parseSubmitArgs(argv: string[]): SubmitArgsParse {
  const values = new Map<string, string>();
  let dryRun = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--yes") yes = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--"))
        return { ok: false, error: `${a} needs a value` };
      if (values.has(a)) return { ok: false, error: `${a} given twice` };
      values.set(a, v);
      i++;
    } else if (a.startsWith("--"))
      return { ok: false, error: `unknown flag ${a}` };
    else
      return {
        ok: false,
        error: `unexpected argument ${JSON.stringify(a)} (every value takes a flag; quote the title)`,
      };
  }
  const title = values.get("--title");
  if (title === undefined) return { ok: false, error: "--title is required" };
  const file = values.get("--file");
  if (file === undefined) return { ok: false, error: "--file is required" };
  return {
    ok: true,
    args: {
      title,
      file,
      md: values.get("--md") ?? null,
      blurbFile: values.get("--blurb-file") ?? null,
      email: values.get("--email") ?? null,
      attribution: values.get("--attribution") ?? null,
      timeSaved: values.get("--time-saved") ?? null,
      dryRun,
      yes,
    },
  };
}

// ── Who is submitting ──────────────────────────────────────────────

/** Just the slice of the environment these two read. Narrower than
 * NodeJS.ProcessEnv on purpose: `process.env` satisfies it, and a test can
 * hand over a two-key object without Next's augmented required NODE_ENV. */
export interface AdminEmailEnv {
  ADMIN_EMAIL?: string | undefined;
  /** Index signature so `process.env` itself is assignable (a weak type of
   * one optional key would be rejected as having nothing in common with it),
   * and so a test can pass a bare object literal. */
  [key: string]: string | undefined;
}

/** The first ADMIN_EMAIL entry as a bare lowercase address, or null when the
 * variable is unset or unparseable. extractAddress is the site's own reader,
 * so `ADMIN_EMAIL="Adam <adam@xl.net>"` resolves the way every mail path
 * already resolves it instead of being mistaken for a malformed address. */
export function firstAdminEmail(env: AdminEmailEnv): string | null {
  const first = (env.ADMIN_EMAIL ?? "").split(",")[0]?.trim() ?? "";
  return extractAddress(first) || null;
}

export type EmailResolve =
  | { ok: true; email: string; fromDefault: boolean }
  | { ok: false; error: string };

/**
 * Settle the submitter address: `--email` when given, else the first
 * ADMIN_EMAIL entry, canonicalised to a bare lowercase address.
 *
 * Lowercased on purpose. The web lane stores whatever the session claimed and
 * every reader that matters case-folds (ownedBy, sameEmail, countCreatedToday
 * all lower() their comparisons), and src/lib/work/transfer.ts already calls
 * the lowercase form "the canonical stored form", so a script that types the
 * address should type it canonically.
 *
 * The address must be in WORK_SUBMIT_DOMAINS. This is NOT the route's session
 * gate (which is not reproduced at all); it is the LANE check that gate
 * implies. A row with companyId null is a public /work row, and the public
 * lane admits xl.net addresses only, so filing one under any other domain
 * would create a row the site itself could never have produced.
 */
export function resolveSubmitterEmail(
  raw: string | null,
  env: AdminEmailEnv
): EmailResolve {
  const fromDefault = raw === null;
  const source = raw ?? firstAdminEmail(env);
  if (!source)
    return {
      ok: false,
      error:
        "no submitter address: ADMIN_EMAIL is unset or unparseable in this environment, so there is no default. Pass --email <addr>.",
    };
  const email = extractAddress(source);
  if (!email)
    return { ok: false, error: `not an email address: ${JSON.stringify(source)}` };
  const domain = emailDomain(email);
  if (domain === null || !WORK_SUBMIT_DOMAINS.includes(domain))
    return {
      ok: false,
      error:
        `${email} is not in the staff lane (${WORK_SUBMIT_DOMAINS.join(", ")}). ` +
        "This script files public /work rows only (company_id null). A client company's private lane needs that company's own domain plus the trusted-session and per-company quota gates, none of which this script reproduces.",
    };
  return { ok: true, email, fromDefault };
}

/** The route's dailyQuota expression for the staff lane (route 239-243):
 * an ADMIN_EMAIL member gets the admin band, anyone else the user band.
 * Company-lane quotas are out of scope (this script never files one). */
export function dailyQuotaFor(admin: boolean): number {
  return admin
    ? WORK_CAPS.submissionsPerAdminPerDay
    : WORK_CAPS.submissionsPerUserPerDay;
}

// ── Field gates (route order) ──────────────────────────────────────

/** route 219-224 */
export const DISABLED_MESSAGE =
  "Submissions are paused right now. Published cards are unaffected.";

/** route 244-249 */
export function quotaRefusal(count: number, quota: number): string | null {
  if (count < quota) return null;
  return `The limit is ${quota} submissions per person per day (failed submissions do not count). Try again tomorrow.`;
}

/** route 299-307 */
export function titleBandRefusal(title: string): string | null {
  if (
    title.length < WORK_CAPS.titleMinChars ||
    title.length > WORK_CAPS.titleMaxChars
  )
    return `Title must be ${WORK_CAPS.titleMinChars} to ${WORK_CAPS.titleMaxChars} characters.`;
  return null;
}

/** route 311-316 */
export function titlePrefixRefusal(title: string): string | null {
  return TITLE_KIND_PREFIX_RE.test(title)
    ? "The title should be just the tool's name; the card's badge already shows the kind. Remove the category prefix and resubmit."
    : null;
}

/** route 323-328 */
export function machineEchoRefusal(title: string): string | null {
  return splitMachineEcho(title)
    ? "The title says the same name twice, once in words and once again in parentheses. Keep just the name, drop the parenthetical repeat, and resubmit."
    : null;
}

/** route 333-338. No minimum by owner directive; only the storage cap. */
export function blurbRefusal(blurb: string): string | null {
  return blurb.length > WORK_CAPS.blurbMaxChars
    ? `Description can be up to ${WORK_CAPS.blurbMaxChars} characters (it is optional; the card is written from your documents).`
    : null;
}

/** route 358-360: the hand-authored exhibit titles, a /work-only concept. */
export function staticTitleClash(title: string): boolean {
  const norm = normalizeTitle(title);
  return staticTitles.titles.some((t: string) => normalizeTitle(t) === norm);
}

/** route 363-367 */
export const PUBLISHED_CLASH_MESSAGE =
  "A published card already uses this title. Pick a different title.";

/** route 369-381, staff-lane arm. `sameEmail` is the route's own case-folded
 * comparison: a transferred row stores the address the mover typed, so raw
 * equality would tell the real owner that "a teammate" holds their row. */
export function activeClashMessage(
  title: string,
  clash: { submitterEmail: string; status: string },
  ownEmail: string
): string {
  return sameEmail(clash.submitterEmail, ownEmail)
    ? `You already have a submission titled "${title}" in the pipeline (status: ${clash.status}). Check it on your submissions page at /work/submit. Removing a submission is admin-only, so ask Adam to clear it if you want to resubmit under this title.`
    : `A teammate already has a submission titled "${title}" in review. Pick a different title, or check with them before resubmitting.`;
}

/** route 626-636, staff-lane arm. */
export function uniqueViolationMessage(title: string): string {
  return `A submission titled "${title}" is already in the pipeline. Check your submissions page at /work/submit.`;
}

export type AttributionParse =
  | { ok: true; attribution: string | null }
  | { ok: false; message: string };

/** route 385-397. Empty stays null (the card credits the XL.net team). */
export function parseAttribution(raw: string | null): AttributionParse {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, attribution: null };
  if (!/^[A-Za-z][A-Za-z'-]{1,19}$/.test(trimmed))
    return {
      ok: false,
      message:
        "The public credit must be a single first name, letters only, 2 to 20 characters. Leave it empty to publish as the XL.net team.",
    };
  return { ok: true, attribution: trimmed };
}

/** route 406-411 */
export const PACKAGE_MISSING_MESSAGE = "Attach your package (.zip or .skill).";

/** route 413-418 */
export function packageNameRefusal(name: string): string | null {
  return /\.(zip|skill)$/.test(name.toLowerCase())
    ? null
    : "The package must be a .zip or .skill file.";
}

/** route 419-424: the declared size. */
export function packageSizeRefusal(size: number): string | null {
  return size > WORK_CAPS.uploadMaxBytes
    ? `That file is too large (limit ${Math.floor(WORK_CAPS.uploadMaxBytes / 1_000_000)} MB).`
    : null;
}

/** route 426-427: the bytes actually read. Deliberately its own gate with
 * its own shorter sentence, exactly as the route has it. */
export function packageBytesRefusal(length: number): string | null {
  return length > WORK_CAPS.uploadMaxBytes ? "That file is too large." : null;
}

/** route 448-453 */
export function mdNameRefusal(name: string): string | null {
  return /\.(md|mdx|markdown)$/.test(name.toLowerCase())
    ? null
    : "The document must be a .md file.";
}

/** route 454-459 */
export function mdSizeRefusal(size: number): string | null {
  return size > WORK_CAPS.skillMdMaxBytes
    ? "That document is too large (limit 1 MB)."
    : null;
}

// ── The kind ladder (route 475-598) ────────────────────────────────

/** route 70-72 (local `kindRefusal`). A refusal that is a CONSEQUENCE of the
 * inferred kind, said so it can be argued with: the verdict sentence leads,
 * because it is the premise and the claim most worth contesting. */
export function kindRefusalText(
  verdict: KindVerdict | undefined,
  message: string
): string {
  return verdict ? `${kindVerdictSentence(verdict)} ${message}` : message;
}

/** route 82-91 (local `standaloneDocError`). Its own copy for the too-short
 * case, because extract.ts's sentence names a Skill and this field now
 * carries a program's architecture doc just as often. */
export function standaloneDocMessage(err: ExtractErr): string {
  return err.code === "doc_too_short"
    ? "The document you attached is too short to review. It needs to describe the tool: what it does, how it is used, and how it works, at least a few paragraphs. Expand it and resubmit."
    : err.message;
}

/** route 104-112 (local `rescuePassError`). The rescue's second pass runs the
 * SKILL ladder over a package the classifier already called a program, so its
 * inner-archive wording ("the packaged Skill inside your zip", "attach its
 * SKILL.md in the second upload field") is wrong twice over for the lane that
 * actually hit it. Everything else passes through kind-neutral. */
export function rescuePassMessage(err: ExtractErr, archiveName: string): string {
  return err.code === "invalid_archive"
    ? `Your package contains an archive that could not be read, so the panel could not finish inspecting ${archiveName}. Remove it, or re-export it as a plain .zip, and resubmit.`
    : err.message;
}

/** route 124-130 (local `outerLevelOnly`). A rescued program's row must not
 * carry inner-archive evidence: the pin to "skill" is a means to a manifest
 * and a corpus, never a licence to store paths from inside a bundle the
 * program lane never opens. */
export function outerLevelOnly(pkg: ExtractOk): ExtractOk {
  return {
    ...pkg,
    manifest: pkg.manifest.filter((m) => !m.path.includes("!/")),
    corpus: pkg.corpus.filter((c) => !c.path.includes("!/")),
  };
}

/** route 482-484: is this failure the kind the standalone-document rescue
 * answers? A program's doc-resolution failure, and only that. The route's
 * remaining conjunct (route 481, a standalone .md was actually attached and
 * parsed) stays at the call site so TypeScript keeps narrowing it. */
export function rescueApplies(extracted: ExtractErr): boolean {
  return (
    extracted.kind === "program" &&
    (extracted.code === "missing_architecture_doc" ||
      extracted.code === "doc_too_short")
  );
}

/** route 529-531: is this hard failure a doc failure (so the refusal leads
 * with the kind verdict and carries the arch-doc instructions)? */
export function isDocFailure(extracted: ExtractErr): boolean {
  return (
    extracted.code === "missing_architecture_doc" ||
    (extracted.code === "doc_too_short" && extracted.kind === "program")
  );
}

/** route 590-591: the md_* name backfilled from a doc that came from INSIDE a
 * skill package, so the retention email still carries it as its own
 * attachment. Skill only, exactly as the route has it. */
export function docBaseName(docPath: string): string {
  return docPath.split("!/").pop()?.split("/").pop() ?? "SKILL.md";
}

// ── Small shared bits the script needs ─────────────────────────────

/** The stored basename for an upload, route-style: an empty name falls back
 * the way `file.name || "upload"` does, and the column is 200 chars. */
export function storedName(basename: string, fallback: string): string {
  return (basename || fallback).slice(0, 200);
}

/** Read the optional description file. Trimmed like the route trims the form
 * field; a missing --blurb-file is an empty description, which is legal
 * (owner directive 2026-08-05: the card is written from the documents). */
export function readBlurb(path: string | null): string {
  if (path === null) return "";
  return readFileSync(path, "utf8").trim();
}

export function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}...` : text;
}
