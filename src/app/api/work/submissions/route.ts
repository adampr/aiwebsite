// POST (create + kick panel) / GET (list mine) - work submissions (§5.16 +
// §5.18). ONE endpoint, two audiences: @xl.net staff (public /work lane) and
// trusted sessions of registered roadmap companies (their private Your Work
// lane); requireWorkUser resolves the scope. Upload bytes are inspected in
// memory; accepted originals persist on the row (transiently) and in the
// on-disk archive store (durably).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { after } from "next/server";
import { brainHealthy } from "@/lib/governance/brain";
import {
  TITLE_KIND_PREFIX_RE,
  WORK_CAPS,
  cleanedBeforeRefusalLead,
  secretsCleanedMessage,
  workSubmissionsEnabled,
  type WorkKind,
} from "@/lib/work/config";
import { decideStorage } from "@/lib/work/cleaning";
import { reportIntakeCleaningIssue } from "@/lib/report-issue";
import { kindVerdictSentence, type KindVerdict } from "@/lib/work/classify";
import {
  activeTitleClash,
  allSubmissionsForList,
  countCreatedToday,
  createSubmission,
  isUniqueViolation,
  liveDescendantId,
  mySubmissionsForList,
  normalizeTitle,
  publishedTitleClash,
  sweepExpiredWork,
} from "@/lib/work/db";
import staticTitles from "@/lib/work/static-titles.json";
import {
  inspectArchive,
  inspectBareMd,
  mergeSkillCorpus,
  skillDocFailureMessage,
  type ExtractErr,
  type ExtractOk,
} from "@/lib/work/extract";
import {
  okJson,
  rateLimit,
  requireWorkUser,
  verifiedWebAdmin,
  workError,
} from "@/lib/work/http";
import { storeArchiveFiles } from "@/lib/work/archive-store";
import { deployBlocksPanel } from "@/lib/work/deploy-window";
import { noteQueueWait, queueReasonFor } from "@/lib/work/queue-signal";
import { sameEmail } from "@/lib/work/transfer";
import { parseTimeSavedHours } from "@/lib/work/time-saved";
import { splitMachineEcho } from "@/lib/work/names";
import { kickPanel } from "@/lib/work/panel";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import { companyById } from "@/lib/roadmap/db";
import { countCreatedTodayForCompany } from "@/lib/work/db";
import { statusView } from "@/lib/work/view";

/** A refusal that is a CONSEQUENCE of the inferred kind, said so it can be
 * argued with (§5.16 kind inference, 2026-08-28). Nobody picks a kind any
 * more, so "your zip needs an architecture document" on its own reads as an
 * arbitrary demand from a submitter who never said the word "program". With
 * the verdict in front of it, the sentence names the files that decided, and
 * a wrong decision becomes arguable against the package instead of against
 * the site. The verdict is optional because ExtractErr carries one only for
 * failures raised AFTER classification; a refusal that precedes it (an
 * unreadable zip) has nothing to disclose and passes through unchanged. */
function kindRefusal(verdict: KindVerdict | undefined, message: string): string {
  return verdict ? `${kindVerdictSentence(verdict)} ${message}` : message;
}

/** The 422 for a standalone document that fails on its own terms.
 *
 * Its own copy for the too-short case, deliberately: extract.ts says "The
 * panel found your Skill's document but it is too short", and this field now
 * carries a program's architecture doc as often as a Skill's SKILL.md, so
 * that sentence would tell a program submitter about a Skill they never
 * mentioned. Everything else inspectBareMd can say (bytes that are not UTF-8,
 * credentials in the text) is already kind-neutral and passes through. */
function standaloneDocError(err: ExtractErr): Response {
  const message =
    err.code === "doc_too_short"
      ? "The document you attached is too short to review. It needs to describe the tool: what it does, how it is used, and how it works, at least a few paragraphs. Expand it and resubmit."
      : err.message;
  // One submitter-facing text, never a second copy field: `instructions` used
  // to repeat this message verbatim here (see workError, 2026-08-29).
  return workError(err.code, message, 422, {
    ...(err.paths ? { paths: err.paths } : {}),
  });
}

/** The rescue's second pass runs the SKILL ladder over a package the
 * classifier already called a program, so its refusals are worded for a Skill
 * submitter: "the packaged Skill inside your zip could not be read ... attach
 * its SKILL.md in the second upload field". Both halves are wrong here. The
 * inner archive is whatever the program happens to bundle (test fixtures, a
 * data set), not a packaged Skill, and the second upload field is the one the
 * submitter ALREADY used, which is the only reason the rescue ran. Left
 * as-is it turns an accurate refusal into one with no path forward, so the
 * inner-archive failures are re-worded for the lane that actually hit them
 * and everything else (credentials, an over-complex archive) passes through
 * with its own copy, which is kind-neutral. */
function rescuePassError(err: ExtractErr, archiveName: string): Response {
  const message =
    err.code === "invalid_archive"
      ? `Your package contains an archive that could not be read, so the panel could not finish inspecting ${archiveName}. Remove it, or re-export it as a plain .zip, and resubmit.`
      : err.message;
  return workError(err.code, message, 422, {
    ...(err.paths ? { paths: err.paths } : {}),
  });
}

/** A rescued program's row must not carry inner-archive evidence. The rescue
 * pins the Skill ladder purely to get a manifest and a corpus back, and that
 * ladder opens a nested archive the program lane never opens, so its result
 * can hold "outer.zip!/inner/file" rows. Storing those would break three
 * stated invariants at once (extract.ts's "kind program never opens nested
 * archives", classify.ts's KindSignals contract, and the reclassification
 * script's assumption that no row carries such a path) and would feed the
 * editorial panel text from inside a bundle the program lane never read. The
 * pin is a means to an end; the end is what a program walk would have
 * produced. */
function outerLevelOnly(pkg: ExtractOk): ExtractOk {
  return {
    ...pkg,
    manifest: pkg.manifest.filter((m) => !m.path.includes("!/")),
    corpus: pkg.corpus.filter((c) => !c.path.includes("!/")),
  };
}

export async function GET(req: Request): Promise<Response> {
  const user = await requireWorkUser();
  if (user instanceof Response) return user;
  const limited = rateLimit(`work:list:${user.userId}`, 60, 30);
  if (limited) return limited;
  // ?scope=all (§5.16 transfer round): the admin "All submissions" view on
  // /work/submit. verifiedWebAdmin, not bare isAdmin — this returns every
  // company's private rows alongside the staff lane, and the Microsoft
  // common-tenant lane can mint an isAdmin-passing session (see the head of
  // src/lib/rfp/access.ts). Anything other than the exact literal "all"
  // falls through to the caller's own list, so a typo can never widen scope.
  const wantsAll = new URL(req.url).searchParams.get("scope") === "all";
  if (wantsAll && !verifiedWebAdmin(user))
    return workError(
      "forbidden",
      "Only an admin can list every submission.",
      403
    );
  try {
    await sweepExpiredWork(25);
  } catch {
    // sweep is best-effort on the read path
  }
  // One more than the cap, so a full page is reported as truncated instead
  // of silently asserting a complete list.
  const cap = WORK_CAPS.submissionListMax;
  const fetched = wantsAll
    ? await allSubmissionsForList(cap + 1)
    : await mySubmissionsForList(user.email, cap + 1);
  const truncated = fetched.length > cap;
  const rows = truncated ? fetched.slice(0, cap) : fetched;
  // Superseded rows carry a pointer to the card's LIVE version (§5.16 chain
  // ownership, 2026-08-04): when the last update came from someone else, the
  // published row is not in this list, and without currentId the submitter
  // has no surface that offers updating their card again.
  // Lane identity for the all list only: one companyById per DISTINCT company
  // among the rows (the /admin/work precedent), never one per row. The admin
  // needs the company's DOMAIN to move one of its rows at all, since that is
  // the only address family the transfer route accepts for it.
  const lanes = new Map<string, { name: string; domain: string }>();
  if (wantsAll) {
    const ids = [
      ...new Set(rows.map((r) => r.companyId).filter((c): c is string => !!c)),
    ];
    for (const cid of ids) {
      try {
        const company = await companyById(cid);
        if (company) lanes.set(cid, { name: company.name, domain: company.domain });
      } catch {
        // no name, no domain: the chip falls back to a generic label
      }
    }
  }
  // currentId is resolved for the submitter's OWN list only. liveDescendantId
  // walks the swap chain one query per hop, so doing it across every
  // superseded row on the site would be dozens of sequential round trips per
  // load; the all view has no use for it either (it offers no "Submit an
  // update" on a row the admin does not own, and it does not dedupe).
  // §5.16 queue-wait reason (2026-08-25 round): why a received row has not
  // started yet, so the tracker can say "a site update is finishing" instead
  // of nothing at all. ONE statSync for the whole page, and only when the
  // page actually holds a received row; the process-local stamp is read per
  // row, because a single global reason rendered under every received row
  // would narrate one submitter's refusal under another's submission.
  const deployBlocks = rows.some((r) => r.status === "received")
    ? deployBlocksPanel({ strict: false })
    : false;
  const views = await Promise.all(
    rows.map(async (r) =>
      statusView(r, {
        queueReason:
          r.status === "received" ? queueReasonFor(r.id, deployBlocks) : null,
        ...(!wantsAll && r.status === "superseded"
          ? { currentId: await liveDescendantId(r.id) }
          : r.companyId
            ? { lane: lanes.get(r.companyId) ?? null }
            : {}),
      })
    )
  );
  return okJson({ submissions: views, scope: wantsAll ? "all" : "mine", truncated });
}

export async function POST(req: Request): Promise<Response> {
  const user = await requireWorkUser();
  if (user instanceof Response) return user;
  const isCompanyLane = user.scope.companyId !== null;
  if (!workSubmissionsEnabled(process.env))
    return workError(
      "disabled",
      "Submissions are paused right now. Published cards are unaffected.",
      503
    );
  // In-memory CPU guard against upload hammering; the durable daily quota
  // is row-counted below. Client caps are deliberately tighter (§5.18): the
  // brain is one shared resource and the roadmap ledger bounds the whole
  // client population, so per-actor quotas stay small.
  const limited = rateLimit(
    `work:submit:${user.userId}`,
    3600,
    isCompanyLane
      ? ROADMAP_CAPS.clientUploadAttemptsPerUserPerHour
      : WORK_CAPS.uploadAttemptsPerUserPerHour
  );
  if (limited) return limited;
  // isAdmin elevation is staff-lane-only by construction: a client admin is
  // a company admin, not an ADMIN_EMAIL entry.
  const dailyQuota = isCompanyLane
    ? ROADMAP_CAPS.clientSubmissionsPerUserPerDay
    : user.admin
      ? WORK_CAPS.submissionsPerAdminPerDay
      : WORK_CAPS.submissionsPerUserPerDay;
  if ((await countCreatedToday(user.email)) >= dailyQuota)
    return workError(
      "quota",
      `The limit is ${dailyQuota} submissions per person per day (failed submissions do not count). Try again tomorrow.`,
      429
    );
  if (
    isCompanyLane &&
    (await countCreatedTodayForCompany(user.scope.companyId as string)) >=
      ROADMAP_CAPS.companySubmissionsPerDay
  )
    return workError(
      "quota",
      `Your company reached its ${ROADMAP_CAPS.companySubmissionsPerDay} submissions for today (failed submissions do not count). Try again tomorrow.`,
      429
    );
  if (!(await brainHealthy()))
    return workError(
      "brain_offline",
      "The review pipeline is briefly offline. Try again shortly.",
      503
    );

  // Content-Length precheck BEFORE any body buffering: req.formData()
  // holds the whole multipart body in this single fork's memory, so the
  // size gate must run before the bytes do. nginx (110m) and the tunnel
  // already cap the wire, but this in-process check is the last line when
  // a request reaches Next another way. Slack covers multipart framing
  // over the file cap; an absent/garbled header falls through to the
  // post-read byte checks below, which remain authoritative.
  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (
    Number.isFinite(contentLength) &&
    contentLength > WORK_CAPS.uploadMaxBytes + 5_000_000
  )
    return workError(
      "invalid_request",
      `That file is too large (limit ${Math.floor(WORK_CAPS.uploadMaxBytes / 1_000_000)} MB).`,
      400
    );
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return workError(
      "invalid_request",
      "Send the submission as multipart form data.",
      400
    );
  }
  // No kind is read from the body. It is not asked on the form, and a value
  // posted under that name is ignored rather than trusted: the package
  // decides (owner directive 2026-08-28), and inspectArchive is handed a null
  // kind below so classify.ts answers from the files.
  const title = String(form.get("title") ?? "").trim();
  if (
    title.length < WORK_CAPS.titleMinChars ||
    title.length > WORK_CAPS.titleMaxChars
  )
    return workError(
      "invalid_request",
      `Title must be ${WORK_CAPS.titleMinChars} to ${WORK_CAPS.titleMaxChars} characters.`,
      400
    );
  // A typed title is authored, so a category prefix is rejected with
  // instructions, never silently rewritten (2026-07-31 incident: email
  // subjects are stripped instead, they are transport artifacts).
  if (TITLE_KIND_PREFIX_RE.test(title))
    return workError(
      "invalid_request",
      "The title should be just the tool's name; the card's badge already shows the kind. Remove the category prefix and resubmit.",
      400
    );
  // Machine-name echo (2026-08-04 incident: "Entra/M365 Security Analyzer
  // (entra-m365-security-analyzer)" published as a card title). The email
  // lanes strip this and disclose it in the receipt; the form REJECTS
  // instead, deliberately: the fix is synchronous with the field still
  // filled in, and the form has no disclosure channel, so a server-side
  // strip would publish a card differing from what the screen showed.
  if (splitMachineEcho(title))
    return workError(
      "invalid_request",
      "The title says the same name twice, once in words and once again in parentheses. Keep just the name, drop the parenthetical repeat, and resubmit.",
      400
    );
  // No minimum (owner directive 2026-08-05): the description is context-only
  // and the panel writes the card from the submitted documents, so an empty
  // description is fine. Only the storage cap is enforced.
  const blurb = String(form.get("blurb") ?? "").trim();
  if (blurb.length > WORK_CAPS.blurbMaxChars)
    return workError(
      "invalid_request",
      `Description can be up to ${WORK_CAPS.blurbMaxChars} characters (it is optional; the card is written from your documents).`,
      400
    );
  // §5.16 "time saved per month for you" (owner ask 2026-08-27): OPTIONAL
  // here, and never present on an email-lane row, so an absent field is a
  // successful parse to null rather than a refusal. Validated at this point
  // and not later because this is the first line where the value exists, and
  // failing here still spares the caller inspectArchive walking the whole
  // package for a submission that is going to be refused over one number.
  // (It cannot spare the UPLOAD itself: req.formData() above has already
  // buffered the multipart body, which is why the size gates run before it.)
  // form.get() returns null when the field was never sent and a File if
  // something posts one under this name; parseTimeSavedHours refuses by TYPE
  // instead of coercing, so neither can be mistaken for a real report.
  const timeSaved = parseTimeSavedHours(form.get("timeSavedHours"));
  if (!timeSaved.ok) return workError("invalid_request", timeSaved.message, 400);
  // Duplicate-title guard (§5.16, 2026-07-30: the owner triple-submitted the
  // same tool because nothing stopped him). One public page, one active
  // submission per title, from anyone; failed rows never block.
  const norm = normalizeTitle(title);
  // Hand-authored exhibit titles are a /work-only concept; company lanes
  // check only their own scope.
  if (
    (!isCompanyLane &&
      staticTitles.titles.some((t: string) => normalizeTitle(t) === norm)) ||
    (await publishedTitleClash(title, user.scope))
  )
    return workError(
      "duplicate_title",
      "A published card already uses this title. Pick a different title.",
      409
    );
  const clash = await activeTitleClash(title, user.scope);
  if (clash)
    return workError(
      "duplicate_title",
      // Case-folded (§5.16 transfer round): a transferred row stores the
      // address the mover TYPED, so raw equality would tell the actual owner
      // that "a teammate" holds their own row.
      sameEmail(clash.submitterEmail, user.email)
        ? isCompanyLane
          ? `You already have a submission titled "${title}" in the pipeline (status: ${clash.status}). Check it on your company's roadmap page at /roadmap/work.`
          : `You already have a submission titled "${title}" in the pipeline (status: ${clash.status}). Check it on your submissions page at /work/submit. Removing a submission is admin-only, so ask Adam to clear it if you want to resubmit under this title.`
        : `A teammate already has a submission titled "${title}" in review. Pick a different title, or check with them before resubmitting.`,
      409
    );

  // Optional public credit: a single validated first name, never derived
  // from the OAuth profile. Empty = the card credits "the XL.net team".
  const rawName = String(form.get("attribution") ?? "").trim();
  let attribution: string | null = null;
  if (rawName) {
    if (!/^[A-Za-z][A-Za-z'-]{1,19}$/.test(rawName))
      return workError(
        "invalid_request",
        isCompanyLane
          ? "The credit must be a single first name, letters only, 2 to 20 characters. Leave it empty to publish under your company's team credit."
          : "The public credit must be a single first name, letters only, 2 to 20 characters. Leave it empty to publish as the XL.net team.",
        400
      );
    attribution = rawName;
  }

  // The package: ONE upload, either shape, from everybody. Both refusals in
  // this stretch are about the envelope (a file is here, it is plausibly an
  // archive, it is small enough) and none of them is about the kind any more:
  // a .zip and a .skill are now equally acceptable from any submitter,
  // because which one they sent is evidence for the classifier rather than a
  // claim to be checked against a declared kind.
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return workError(
      "invalid_request",
      "Attach your package (.zip or .skill).",
      400
    );
  const name = file.name || "upload";
  if (!/\.(zip|skill)$/.test(name.toLowerCase()))
    return workError(
      "invalid_request",
      "The package must be a .zip or .skill file.",
      400
    );
  if (file.size > WORK_CAPS.uploadMaxBytes)
    return workError(
      "invalid_request",
      `That file is too large (limit ${Math.floor(WORK_CAPS.uploadMaxBytes / 1_000_000)} MB).`,
      400
    );
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > WORK_CAPS.uploadMaxBytes)
    return workError("invalid_request", "That file is too large.", 400);
  // No magic-byte gate (owner directive 2026-08-05, same ruling as the email
  // lane): inspectArchive attempts the parse and names what the bytes are
  // when it fails.

  // The standalone reviewed document: OPTIONAL (owner directive 2026-07-30,
  // a package that already carries the doc needs no second upload) and, as
  // of 2026-08-28, taken from EVERY submission rather than only from Skills.
  // It had to be ungated the moment the kind stopped being declared: the form
  // shows this field to everyone because it cannot know what the package is,
  // so refusing a program's separately attached architecture doc would refuse
  // a file the site itself invited.
  //
  // "skillMd" is the historical wire name and it stays. It is what a Skill's
  // SKILL.md has always arrived in, the email lane maps its own attachment
  // onto the same slot, and renaming it would mean changing the form, both
  // routes and the intake in lockstep for a label nobody reads.
  let mdFile: { name: string; bytes: Buffer } | null = null;
  const md = form.get("skillMd");
  if (md instanceof File && md.size > 0) {
    const mdName = md.name || "SKILL.md";
    if (!/\.(md|mdx|markdown)$/.test(mdName.toLowerCase()))
      return workError(
        "invalid_request",
        "The document must be a .md file.",
        400
      );
    if (md.size > WORK_CAPS.skillMdMaxBytes)
      return workError(
        "invalid_request",
        "That document is too large (limit 1 MB).",
        400
      );
    mdFile = { name: mdName, bytes: Buffer.from(await md.arrayBuffer()) };
  }

  // null, so the ladder in classify.ts decides. The kind that comes back is
  // the one stored on the row; nothing upstream of this line has an opinion.
  const extracted = await inspectArchive(bytes, null, { packageName: name });
  // The standalone is validated exactly ONCE, here, and deliberately after
  // the package walk rather than where it is read: an archive carrying
  // credentials has to keep refusing with the secrets message, which is the
  // one a submitter must act on fastest, and checking the .md first would let
  // "your document is too short" answer for a package that is worse than
  // that. inspectBareMd is pure and cheap, so computing it for a package that
  // then refuses costs nothing.
  const mdExtract = mdFile ? inspectBareMd(mdFile.name, mdFile.bytes) : null;

  let pkg: ExtractOk;
  let kind: WorkKind;
  if (extracted.ok) {
    pkg = extracted;
    kind = extracted.kind;
  } else if (
    mdExtract &&
    extracted.kind === "program" &&
    (extracted.code === "missing_architecture_doc" ||
      extracted.code === "doc_too_short")
  ) {
    // ---- the standalone-document rescue, made symmetric (2026-08-28) ----
    // A Skill's doc-resolution failure has always been rescuable by the
    // second upload field: the skill ladder returns ok-with-docMissing
    // precisely so this route can put the attached .md in the reviewed slot.
    // The program ladder hard-fails instead, so a program whose architecture
    // doc sat beside the zip instead of inside it was a dead end. That was
    // defensible while the form asked which kind you were sending and offered
    // the .md field to Skills only. It stopped being defensible the moment
    // the form started offering that field to everyone: the site would be
    // refusing a document it had just invited, over a kind the submitter
    // never chose.
    //
    // HOW: a second walk with the kind PINNED to "skill". extract.ts is not
    // ours to change this round, and its ExtractErr carries no manifest and
    // no corpus, so there is nothing in the failed result to build a row out
    // of; the skill ladder never hard-fails on doc resolution, so pinning it
    // returns exactly what is missing (manifest, corpus, hashes) for the very
    // same bytes. The cost is one extra inflate, paid only by a package that
    // was otherwise about to be refused outright and only when a .md is
    // actually attached, so no accepted submission and no ordinary refusal
    // pays for it. The alternative that avoids the second walk (pin "skill"
    // on the FIRST pass whenever a .md is attached, and store
    // kindVerdict.kind) was rejected: it would change the inspection of every
    // submission that attaches a document, opening a nested .skill the
    // program lane never opens, to save CPU on the rarest path here.
    //
    // The pinned kind is a MEANS, never a result: `kind` below is taken from
    // the first pass, which is the inferred one, so a program rescued this
    // way is stored as a program and reviewed as one.
    if (!mdExtract.ok) return standaloneDocError(mdExtract);
    const rescue = await inspectArchive(bytes, "skill", { packageName: name });
    // The skill pass opens a single inner .skill that the program pass never
    // looked at, so it can still fail on that inner archive. Those refusals
    // stand: a rescue supplies a missing document, it never makes an
    // unreadable package readable. It no longer has anything to say about
    // credentials: since 2026-08-29 an inner archive holding them is DROPPED
    // and the walk continues, on this pass exactly as on the first.
    if (!rescue.ok) return rescuePassError(rescue, name);
    pkg = outerLevelOnly(rescue);
    kind = extracted.kind;
  } else {
    // Hard failures (invalid archive, too complex, and a program doc failure
    // with nothing attached that could have carried the document): reject and
    // instruct; NEVER rescued by a standalone .md beyond the one case above,
    // because a document cannot answer for a package that could not be read.
    // Credentials are NOT in this list any more: they are cleaned, not
    // refused, so a refusal reached after a cleaning leads with what the
    // cleaning removed (cleanedBeforeRefusalLead) instead.
    const docFailure =
      extracted.code === "missing_architecture_doc" ||
      (extracted.code === "doc_too_short" && extracted.kind === "program");
    const body = docFailure
      ? kindRefusal(extracted.kindVerdict, extracted.message)
      : extracted.message;
    return workError(
      extracted.code,
      extracted.droppedPaths
        ? `${cleanedBeforeRefusalLead(extracted.droppedPaths)}\n\n${body}`
        : body,
      422,
      // No `instructions` twin: `extracted.message` for a program document
      // failure IS the instruction paragraph (extract.ts sets
      // MISSING_ARCH_DOC_MESSAGE for both codes), so the field shipped the
      // same six sentences a second time in every one of these bodies. It was
      // invisible only because the form renders `message` alone, and that is
      // an accident, not a control: the email lane read the same two-field
      // shape as a division of labour and printed both (2026-08-28).
      { ...(extracted.paths ? { paths: extracted.paths } : {}) }
    );
  }

  // Reviewed-doc precedence, the same ladder for both kinds now: a standalone
  // upload always wins; else the package's resolved doc; else the skill
  // ladder's doc-resolution failure, which only a standalone could have
  // rescued, so with neither it rejects here.
  let docText = pkg.docText;
  let corpus = pkg.corpus;
  let mdMeta: { name: string; sha256: string; bytes: number; data: Buffer } | undefined;
  if (mdFile && mdExtract) {
    if (!mdExtract.ok) return standaloneDocError(mdExtract);
    docText = mdExtract.docText;
    // mergeSkillCorpus is named for the lane it was written for and is
    // kind-blind in what it does (the standalone first, then the package's
    // texts minus byte-identical duplicates, under the corpus cap), so it is
    // the merge for a rescued program too.
    corpus = mergeSkillCorpus(mdExtract, pkg);
    mdMeta = {
      name: mdFile.name.slice(0, 200),
      sha256: mdExtract.archiveSha256,
      bytes: mdFile.bytes.length,
      data: mdFile.bytes,
    };
  } else if (pkg.docMissing) {
    // Only the skill ladder returns ok-with-docMissing (the program ladder
    // hard-fails above and is caught in the branch that refuses), so this is
    // the Skill refusal, and it discloses the verdict for the same reason the
    // program one does: the submitter never said "Skill", the files did, and
    // "the panel could not find your SKILL.md" is answerable only by someone
    // who knows a Skill is what this was read as.
    const message = skillDocFailureMessage(pkg.docMissing);
    return workError(
      `skill_doc_${pkg.docMissing}`,
      kindRefusal(pkg.kindVerdict, message),
      422,
      { ...(pkg.candidatePaths ? { paths: pkg.candidatePaths } : {}) }
    );
  } else if (kind === "skill" && pkg.docRawBytes) {
    // Doc came from inside the package: retention still carries it as its own
    // attachment (md_* backfilled from the untruncated raw bytes). Skill only,
    // exactly as before this round: a program's architecture doc has never
    // been split back out of the archive into the md_* columns, and doing it
    // now would change what the retention email attaches for every program
    // ever submitted, which is nothing this round was asked to decide.
    const docBase =
      pkg.docPath.split("!/").pop()?.split("/").pop() ?? "SKILL.md";
    mdMeta = {
      name: docBase.slice(0, 200),
      sha256: createHash("sha256").update(pkg.docRawBytes).digest("hex"),
      bytes: pkg.docRawBytes.length,
      data: pkg.docRawBytes,
    };
  }

  // What we are allowed to keep. On the common path this hands back the
  // submitted bytes untouched; when the intake scan found something it hands
  // back the cleaned rebuild, and when that rebuild could not be verified it
  // hands back null and we store no archive at all rather than the bytes we
  // were told to clean.
  const storage = decideStorage({
    pkg,
    submittedArchive: bytes,
    // ONLY the standalone-upload branch has its own walk to carry a cleaning
    // record. When mdMeta was built from pkg.docRawBytes instead (the doc came
    // from inside the package), those bytes are already the cleaned ones, so
    // there is nothing to decide and mdData below falls through to them.
    md:
      mdFile && mdExtract?.ok
        ? { extract: mdExtract, submitted: mdFile.bytes }
        : null,
  });
  const mdForRow = mdMeta
    ? { ...mdMeta, data: storage.mdData ?? mdMeta.data }
    : undefined;
  if (storage.cleaned && storage.failed)
    console.warn(
      `[work] archive NOT stored: cleaning rebuild failed (${storage.failed})`
    );

  let row;
  try {
    row = await createSubmission({
    companyId: user.scope.companyId,
    userId: user.userId,
    email: user.email,
    name: attribution,
    kind,
    title,
    blurb,
    // null when the field was empty or 0 (the parser's "not reported"), which
    // is what every email-lane row carries too. The owner can set or change
    // it afterwards on their own row via the time-saved route.
    timeSavedMinutes: timeSaved.minutes,
    architectureText: kind === "program" ? docText : null,
    skillMdText: kind === "skill" ? docText : null,
    fileManifestJson: JSON.stringify(pkg.manifest),
    corpusFilesJson: JSON.stringify(corpus),
    archiveName: name.slice(0, 200),
    archiveSha256: pkg.archiveSha256,
    archiveBytes: pkg.archiveBytes,
    // Retained until the owner retention email sends on publish (§5.16);
    // non-published rows drop them with the row. Since 2026-08-29 this is what
    // the cleaning decided, which is the submitted bytes when nothing was
    // found and null when a rebuild could not be verified.
      archiveData: storage.archiveData,
      md: mdForRow,
      cleaningJson: storage.cleaningJson,
    });
  } catch (err) {
    // The partial unique index closes the double-click race the pre-check
    // leaves open; map the violation to the same 409. isUniqueViolation
    // walks the cause chain: drizzle wraps the PostgresError, so a bare
    // message check never fired (latent bug fixed 2026-08-03).
    if (isUniqueViolation(err, "work_sub_active_title_uq"))
      return workError(
        "duplicate_title",
        `A submission titled "${title}" is already in the pipeline. Check ${isCompanyLane ? "your company's roadmap page at /roadmap/work" : "your submissions page at /work/submit"}.`,
        409
      );
    throw err;
  }

  // Durable second copy at accept time (archive-store.ts): the same file
  // set the row's bytea carries, so publish-time verification can clear the
  // blob. A store failure logs and never fails the submission.
  if (storage.cleaned)
    reportIntakeCleaningIssue({
      // Episodic: one row per lane, not per submission. A per-submission or
      // per-rule key would fill the ledger's 500-row read window and evict
      // every other open issue from the standing triage.
      // A FAILED rebuild gets its own key, not the routine cleaning one.
      // Both are episodic per lane, so this adds one bounded row rather than a
      // row per event, and it buys the thing that matters: "we accepted this
      // and durably stored nothing" can no longer be overwritten by the next
      // ordinary cleaning, whose last-wins detail would otherwise bury it.
      key: storage.failed
        ? "work-intake:cleaning-failed:web-create"
        : "work-intake:cleaned:web-create",
      subject: storage.failed
        ? "A /work submission (web create) was cleaned but NO archive could be stored"
        : "Credential-shaped content cleaned from a /work submission (web create)",
      detail: [
        `submission ${row.id} (${title})`,
        `submitter ${user.email}`,
        `cleaned: ${storage.cleanedPaths.join(", ")}`,
        ...(storage.failed ? [`archive NOT stored: ${storage.failed}`] : []),
        "The submitter was shown the rotate-anyway notice.",
      ].join("\n"),
      // The web lanes send no mail here, so [never-emailed] in the triage
      // listing is accurate rather than an alarm.
      emailed: false,
    });

  // Never the submitted bytes: this is the durable copy, so it gets exactly
  // what the row got. A failed rebuild stores nothing here either.
  if (storage.archiveData)
    await storeArchiveFiles(row.id, title, [
      { name: name.slice(0, 200), data: storage.archiveData },
      ...(mdForRow ? [{ name: mdForRow.name, data: mdForRow.data }] : []),
    ]);

  // The row exists; a kick failure must degrade to "queued", never 500 the
  // submission out from under the user (2026-07-30 incident: a claim-query
  // bug turned every first submit into a bare 500).
  let kicked: Awaited<ReturnType<typeof kickPanel>>;
  try {
    kicked = await kickPanel(row.id);
  } catch (err) {
    console.log(
      `[work] kickPanel threw on ${row.id}: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
    );
    kicked = { outcome: { status: "refused", reason: "claim" } };
  }
  if (kicked.run) after(kicked.run); // runPanel never throws
  // Stamp WHY the queue refused, keyed to this row, so the submitter's next
  // poll narrates the wait. The 202 body below already carried the reason;
  // the stamp is what makes it survive into the poll path after the dialog
  // is reopened or the submissions page is reloaded.
  if (kicked.outcome.status === "refused")
    noteQueueWait(row.id, kicked.outcome.reason);
  return okJson(
    {
      id: row.id,
      status: kicked.outcome.status === "running" ? "running" : "received",
      queued:
        kicked.outcome.status === "refused" ? kicked.outcome.reason : null,
      // The cleaning disclosure. The submitter has to learn two things a
      // success response does not normally carry: that we changed their files,
      // and that they still need to rotate whatever was in them.
      cleaned: storage.cleaned
        ? {
            message: secretsCleanedMessage(storage.cleanedPaths.length),
            paths: storage.cleanedPaths,
          }
        : null,
    },
    202
  );
}
