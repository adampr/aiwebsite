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
  isWorkKind,
  MISSING_ARCH_DOC_MESSAGE,
  TITLE_KIND_PREFIX_RE,
  WORK_CAPS,
  workSubmissionsEnabled,
} from "@/lib/work/config";
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
  const kind = form.get("kind");
  if (!isWorkKind(kind))
    return workError("invalid_request", "Pick a submission kind.", 400);
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

  // The package: a .zip for a Code program, a .skill/.zip for a CoWork
  // Skill. A CoWork Skill ALSO requires the standalone SKILL.md (owner
  // directive: both files, both retained).
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return workError(
      "invalid_request",
      kind === "program"
        ? "Attach the .zip of your program."
        : "Attach the Skill package (.skill or .zip).",
      400
    );
  const name = file.name || "upload";
  if (!/\.(zip|skill)$/.test(name.toLowerCase()))
    return workError(
      "invalid_request",
      kind === "program"
        ? "A Code program submission must be a .zip archive."
        : "The Skill package must be a .skill or .zip file.",
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

  // The standalone SKILL.md is OPTIONAL (owner directive 2026-07-30): a
  // package that already carries the doc needs no second upload.
  let mdFile: { name: string; bytes: Buffer } | null = null;
  if (kind === "skill") {
    const md = form.get("skillMd");
    if (md instanceof File && md.size > 0) {
      const mdName = md.name || "SKILL.md";
      if (!/\.(md|mdx|markdown)$/.test(mdName.toLowerCase()))
        return workError(
          "invalid_request",
          "The Skill's document must be a .md file.",
          400
        );
      if (md.size > WORK_CAPS.skillMdMaxBytes)
        return workError(
          "invalid_request",
          "The SKILL.md is too large (limit 1 MB).",
          400
        );
      mdFile = { name: mdName, bytes: Buffer.from(await md.arrayBuffer()) };
    }
  }

  const extracted = await inspectArchive(bytes, kind);
  if (!extracted.ok) {
    // Hard failures (secrets, invalid archive, too complex, program doc
    // rules): reject and instruct; NEVER rescued by a standalone .md (a
    // clean standalone must not launder a dirty archive).
    return workError(extracted.code, extracted.message, 422, {
      ...(extracted.paths ? { paths: extracted.paths } : {}),
      ...(extracted.code === "missing_architecture_doc" ||
      (extracted.code === "doc_too_short" && kind === "program")
        ? { instructions: MISSING_ARCH_DOC_MESSAGE }
        : {}),
    });
  }

  // Reviewed-doc precedence for kind=skill: a standalone upload always wins;
  // else the package's resolved doc; else the doc-resolution failure is
  // recoverable ONLY by a standalone, so with neither it rejects here.
  let docText = extracted.docText;
  let corpus = extracted.corpus;
  let mdMeta: { name: string; sha256: string; bytes: number; data: Buffer } | undefined;
  if (kind === "skill") {
    if (mdFile) {
      const mdExtract = inspectBareMd(mdFile.name, mdFile.bytes);
      if (!mdExtract.ok)
        return workError(mdExtract.code, mdExtract.message, 422, {
          ...(mdExtract.paths ? { paths: mdExtract.paths } : {}),
          instructions: mdExtract.message,
        });
      docText = mdExtract.docText;
      corpus = mergeSkillCorpus(mdExtract, extracted);
      mdMeta = {
        name: mdFile.name.slice(0, 200),
        sha256: mdExtract.archiveSha256,
        bytes: mdFile.bytes.length,
        data: mdFile.bytes,
      };
    } else if (extracted.docMissing) {
      const message = skillDocFailureMessage(extracted.docMissing);
      return workError(`skill_doc_${extracted.docMissing}`, message, 422, {
        ...(extracted.candidatePaths ? { paths: extracted.candidatePaths } : {}),
        instructions: message,
      });
    } else if (extracted.docRawBytes) {
      // Doc came from inside the package: retention still carries it as its
      // own attachment (md_* backfilled from the untruncated raw bytes).
      const docBase =
        extracted.docPath.split("!/").pop()?.split("/").pop() ?? "SKILL.md";
      mdMeta = {
        name: docBase.slice(0, 200),
        sha256: createHash("sha256")
          .update(extracted.docRawBytes)
          .digest("hex"),
        bytes: extracted.docRawBytes.length,
        data: extracted.docRawBytes,
      };
    }
  }

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
    fileManifestJson: JSON.stringify(extracted.manifest),
    corpusFilesJson: JSON.stringify(corpus),
    archiveName: name.slice(0, 200),
    archiveSha256: extracted.archiveSha256,
    archiveBytes: extracted.archiveBytes,
    // Retained until the owner retention email sends on publish (§5.16);
    // non-published rows drop them with the row.
      archiveData: bytes,
      md: mdMeta,
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
  await storeArchiveFiles(row.id, title, [
    { name: name.slice(0, 200), data: bytes },
    ...(mdMeta ? [{ name: mdMeta.name, data: mdMeta.data }] : []),
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
    },
    202
  );
}
