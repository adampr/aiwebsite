// POST - propose an UPDATE to a published community card (§5.16
// admin-mediated updates, 2026-08-03). Creates a NEW row with parent_id set;
// title and kind are PINNED to the predecessor (renames stay admin-CLI-only)
// and the panel result parks as pending_approval for the admin swap click.
// ONE exception (owner ruling 2026-08-03): a verified-staff admin session
// (verifiedWebAdmin) stamps autoApprove at intake, and a PASSING panel run
// then swaps the card live itself via finishUpdateRow; approving your own
// submission is ceremony. Nothing on this route swaps synchronously, and
// teammate + email-lane updates still change nothing until the admin
// approves on /admin/work.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { after } from "next/server";
import { brainHealthy } from "@/lib/governance/brain";
import {
  WORK_CAPS,
  cleanedBeforeRefusalLead,
  secretsCleanedMessage,
  workSubmissionsEnabled,
  type WorkKind,
} from "@/lib/work/config";
import { decideStorage } from "@/lib/work/cleaning";
import { reportIntakeCleaningIssue } from "@/lib/report-issue";
import {
  activeTitleClash,
  canProposeUpdate,
  countCreatedToday,
  createSubmission,
  isUniqueViolation,
  publishedTitleClash,
  submissionById,
} from "@/lib/work/db";
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
  requireXlUser,
  verifiedWebAdmin,
  workError,
} from "@/lib/work/http";
import { storeArchiveFiles } from "@/lib/work/archive-store";
import { kickPanel } from "@/lib/work/panel";

type Ctx = { params: Promise<{ id: string }> };

/** The 422 for a standalone document that fails on its own terms. A verbatim
 * twin of the create route's, and duplicated rather than shared for the same
 * reason every other refusal sentence in these two files is: the copy in this
 * route speaks about an UPDATE and the two are free to diverge, and this file
 * already carries its own copy of the .md extension and size messages. The
 * too-short case gets local copy because extract.ts's version says "your
 * Skill's document", and this field now carries a program's architecture doc
 * just as often. */
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

const NOT_FOUND = () =>
  workError("not_found", "That submission does not exist.", 404);

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

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  if (!workSubmissionsEnabled(process.env))
    return workError(
      "disabled",
      "Submissions are paused right now. Published cards are unaffected.",
      503
    );
  // SHARED limiter pool with creates: an update is an ordinary submission
  // for quota purposes (it burns a full panel run).
  const limited = rateLimit(
    `work:submit:${user.userId}`,
    3600,
    WORK_CAPS.uploadAttemptsPerUserPerHour
  );
  if (limited) return limited;
  const dailyQuota = user.admin
    ? WORK_CAPS.submissionsPerAdminPerDay
    : WORK_CAPS.submissionsPerUserPerDay;
  if ((await countCreatedToday(user.email)) >= dailyQuota)
    return workError(
      "quota",
      `The limit is ${dailyQuota} submissions per person per day (failed submissions do not count). Try again tomorrow.`,
      429
    );
  if (!(await brainHealthy()))
    return workError(
      "brain_offline",
      "The review pipeline is briefly offline. Try again shortly.",
      503
    );

  // Predecessor + ownership, ONE identical 404 for missing, unpublished,
  // and not-owned (the [id] GET precedent: no existence or ownership
  // oracle). Checked before the form is read.
  const { id } = await ctx.params;
  const row = await submissionById(id);
  // Ownership is CHAIN ownership (2026-08-04): every approved swap makes the
  // updater's row the published one, so a submitterEmail-only check would
  // hand the card to the last updater and lock the original author out.
  if (
    !row ||
    row.status !== "published" ||
    !row.cardJson ||
    !(await canProposeUpdate(row, user.email, user.admin))
  )
    return NOT_FOUND();
  // §5.18: the update lane is staff-only in v1. A company card must NEVER be
  // an update target: the child would carry company_id NULL (the 0035 CHECK
  // forbids anything else), so a passing swap would publish company-derived
  // content onto the PUBLIC /work page. publishWithSupersede re-checks this
  // inside its transaction; same 404 shape as the email lane's rejection so
  // this route is no oracle for company card ids.
  if (row.companyId !== null) return NOT_FOUND();
  const kind = row.kind as WorkKind;

  // Content-Length precheck BEFORE any body buffering (same guard and
  // rationale as the create route): the size gate must run before this
  // single fork holds the multipart body; nginx caps the wire, this is the
  // in-process last line. Absent/garbled header falls through to the
  // post-read byte checks, which remain authoritative.
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
      "Send the update as multipart form data.",
      400
    );
  }
  // Title and kind are pinned; a typed value is a conflict, never silently
  // ignored (the email path's R4/R5 rule).
  if (String(form.get("title") ?? "").trim())
    return workError(
      "invalid_request",
      "An update keeps the published card's title, and renaming a card is admin only. Remove the title field, or ask Adam if the card should be renamed.",
      400
    );
  // The current form does not send this field AT ALL, on either lane (the
  // kind is inferred on a create and pinned here), so in practice this guard
  // never fires from the site. It stays as the defence it always was, against
  // a stale client cached from before 2026-08-28 or a hand-built POST: a
  // typed value that disagrees with the card is a conflict to be surfaced,
  // never something to ignore, because the person who sent it believes they
  // are replacing the card with a different kind of thing.
  const sentKind = String(form.get("kind") ?? "").trim();
  if (sentKind && sentKind !== kind)
    return workError(
      "invalid_request",
      `The published card "${row.title}" is a ${kind === "skill" ? "CoWork Skill" : "Code program"}, so an update to it must be one too. Resubmit with the matching package type.`,
      400
    );
  // No minimum (owner directive 2026-08-05, same as the create route): the
  // description is context-only; only the storage cap is enforced.
  const blurb = String(form.get("blurb") ?? "").trim();
  if (blurb.length > WORK_CAPS.blurbMaxChars)
    return workError(
      "invalid_request",
      `Description can be up to ${WORK_CAPS.blurbMaxChars} characters (it is optional; the card is written from your documents).`,
      400
    );
  const rawName = String(form.get("attribution") ?? "").trim();
  let attribution: string | null = null;
  if (rawName) {
    if (!/^[A-Za-z][A-Za-z'-]{1,19}$/.test(rawName))
      return workError(
        "invalid_request",
        "The public credit must be a single first name, letters only, 2 to 20 characters. Leave it empty to publish as the XL.net team.",
        400
      );
    attribution = rawName;
  }

  // One in-flight update per card: the pinned title trips the active-title
  // guard on any unresolved sibling; exceptId keeps the predecessor itself
  // out of the published check.
  if (await publishedTitleClash(row.title, { companyId: null }, { exceptId: id }))
    return workError(
      "duplicate_title",
      "Another published card now uses this title. Ask Adam to sort the titles out before updating.",
      409
    );
  const clash = await activeTitleClash(row.title, { companyId: null });
  if (clash)
    return workError(
      "duplicate_title",
      clash.submitterEmail.toLowerCase() === user.email.toLowerCase()
        ? `You already have an update to "${row.title}" in the pipeline (status: ${clash.status}). Check it at /work/submit. Removing a submission is admin-only, so ask Adam to clear it if you want to replace it with this version.`
        : `A teammate already has an update to "${row.title}" in review. Only one update per card can be open at a time, so check with them or wait until theirs is decided.`,
      409
    );

  // Envelope checks only, and kind-neutral even though the kind IS known
  // here. The rule stated a few lines down (a package the create lane accepts
  // has to be acceptable as an update) is the reason: the create lane now
  // takes a .zip or a .skill from anyone, and the form offers both in update
  // mode too, so refusing a .skill against a program card would refuse a file
  // the site just invited. The card's kind is pinned by the row, never by the
  // file extension, so nothing downstream needs the extension to agree.
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return workError(
      "invalid_request",
      "Attach the updated package (.zip or .skill).",
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
  // No magic-byte gate (owner directive 2026-08-05). This is the THIRD
  // inspectArchive call site and it must move with the other two: a package
  // the create lane accepts has to be acceptable as an update, or the same
  // bytes publish a new card and bounce as a new version of it.
  // inspectArchive attempts the parse and names what the bytes are.
  // The standalone reviewed document, ungated from the kind (2026-08-28) in
  // lockstep with the create route: the one form serves both lanes, so an
  // update to a PROGRAM card can now carry its architecture doc as the second
  // file, exactly as an update to a Skill card has always carried its
  // SKILL.md. "skillMd" is the historical wire name for the slot; see the
  // create route for why it is not being renamed.
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

  // PINNED, unlike the create route's null: a card's kind is a property of
  // the card, so the package is inspected under the rule the published card
  // already lives by. The walk still classifies the bytes and hands back its
  // verdict; a package that reads as the OTHER kind is not an error here and
  // gets no refusal (a program that grew a SKILL.md, or a Skill that gained a
  // package.json, is still an update to that card), which is exactly why the
  // pinned kind and the verdict are two separate fields on the result.
  const extracted = await inspectArchive(bytes, kind, { packageName: name });
  // Validated once, after the package walk, for the reason the create route
  // spells out: an archive with credentials in it must still refuse with the
  // secrets message rather than with a note about the attached document.
  const mdExtract = mdFile ? inspectBareMd(mdFile.name, mdFile.bytes) : null;

  let pkg: ExtractOk;
  if (extracted.ok) {
    pkg = extracted;
  } else if (
    mdExtract &&
    kind === "program" &&
    (extracted.code === "missing_architecture_doc" ||
      extracted.code === "doc_too_short")
  ) {
    // The same symmetric rescue the create route grew on 2026-08-28, and it
    // has to be here too or the two lanes contradict each other: a program
    // whose architecture doc travels as the second file would publish as a
    // new card and then bounce as an update to it. Second walk with the kind
    // pinned to "skill" purely because that ladder never hard-fails on doc
    // resolution and so returns the manifest and corpus the failed result
    // does not carry; see the create route for the full reasoning. The stored
    // kind is untouched by it: `kind` is the parent row's and nothing below
    // reads the rescue pass's own.
    if (!mdExtract.ok) return standaloneDocError(mdExtract);
    const rescue = await inspectArchive(bytes, "skill", { packageName: name });
    if (!rescue.ok) return rescuePassError(rescue, name);
    pkg = outerLevelOnly(rescue);
  } else {
    return workError(
      extracted.code,
      extracted.droppedPaths
        ? `${cleanedBeforeRefusalLead(extracted.droppedPaths)}\n\n${extracted.message}`
        : extracted.message,
      422,
      {
        ...(extracted.paths ? { paths: extracted.paths } : {}),
      }
    );
  }

  // Reviewed-doc precedence, the same ladder for both kinds now: the
  // standalone wins when there is one, else the package's resolved doc, else
  // the Skill doc-resolution failure that only a standalone could have
  // rescued.
  let docText = pkg.docText;
  let corpus = pkg.corpus;
  let mdMeta:
    | { name: string; sha256: string; bytes: number; data: Buffer }
    | undefined;
  if (mdFile && mdExtract) {
    if (!mdExtract.ok) return standaloneDocError(mdExtract);
    docText = mdExtract.docText;
    corpus = mergeSkillCorpus(mdExtract, pkg);
    mdMeta = {
      name: mdFile.name.slice(0, 200),
      sha256: mdExtract.archiveSha256,
      bytes: mdFile.bytes.length,
      data: mdFile.bytes,
    };
  } else if (pkg.docMissing) {
    // Skill lane only: the program ladder hard-fails above instead of
    // returning ok-with-docMissing.
    const message = skillDocFailureMessage(pkg.docMissing);
    return workError(`skill_doc_${pkg.docMissing}`, message, 422, {
      ...(pkg.candidatePaths ? { paths: pkg.candidatePaths } : {}),
    });
  } else if (kind === "skill" && pkg.docRawBytes) {
    // Skill only, exactly as before this round: a program's architecture doc
    // has never been split back out of the archive into the md_* columns.
    const docBase =
      pkg.docPath.split("!/").pop()?.split("/").pop() ?? "SKILL.md";
    mdMeta = {
      name: docBase.slice(0, 200),
      sha256: createHash("sha256").update(pkg.docRawBytes).digest("hex"),
      bytes: pkg.docRawBytes.length,
      data: pkg.docRawBytes,
    };
  }

  const storage = decideStorage({
    pkg,
    submittedArchive: bytes,
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
      `[work] archive NOT stored on update: cleaning rebuild failed (${storage.failed})`
    );

  let child;
  try {
    child = await createSubmission({
      companyId: null, // staff lane by construction (company parents 404 above)
      userId: user.userId,
      email: user.email,
      name: attribution,
      kind,
      title: row.title,
      blurb,
      // NO time-saved value here on purpose. §5.16's figure is inherited
      // from the parent at SWAP time, inside publishWithSupersede, which is
      // the one primitive both swap paths reach. Copying it at intake was
      // wrong three ways: the time-saved route is status-blind, so a
      // correction the owner makes on the LIVE parent while this child waits
      // for approval would be reverted by a snapshot taken here; the EMAIL
      // update lane never runs this code, so an emailed update published the
      // card with the figure gone; and an update submitted by someone else
      // (an admin, or an earlier owner in the supersede chain) would
      // republish one person's self-reported number under another person's
      // row, where it also lands in that person's scorecard column.
      architectureText: kind === "program" ? docText : null,
      skillMdText: kind === "skill" ? docText : null,
      fileManifestJson: JSON.stringify(pkg.manifest),
      corpusFilesJson: JSON.stringify(corpus),
      archiveName: name.slice(0, 200),
      archiveSha256: pkg.archiveSha256,
      archiveBytes: pkg.archiveBytes,
      archiveData: storage.archiveData,
      md: mdForRow,
      cleaningJson: storage.cleaningJson,
      parentId: id,
      // The ONLY call site that may arm this (web session, verified-staff
      // admin). The email lane's DKIM-authenticated From is spoofable and
      // must never reach an autoApprove row.
      autoApprove: verifiedWebAdmin(user),
    });
  } catch (err) {
    if (
      isUniqueViolation(
        err,
        "work_sub_active_title_uq",
        "work_sub_parent_active_uq"
      )
    )
      return workError(
        "duplicate_title",
        `An update for "${row.title}" is already in review, and only one can be open at a time. Check /work/submit, or ask Adam to clear the pending one.`,
        409
      );
    throw err;
  }

  // Durable second copy at accept time (archive-store.ts), same seam as the
  // create route; failure logs and never fails the update.
  if (storage.cleaned)
    reportIntakeCleaningIssue({
      key: "work-intake:cleaned:web-update",
      subject: "Credential-shaped content cleaned from a /work update (web)",
      detail: [
        `update row ${child.id} for card ${row.id} (${row.title})`,
        `submitter ${user.email}`,
        `cleaned: ${storage.cleanedPaths.join(", ")}`,
        ...(storage.failed ? [`archive NOT stored: ${storage.failed}`] : []),
      ].join("\n"),
      emailed: false,
    });

  if (storage.archiveData)
    await storeArchiveFiles(child.id, row.title, [
      { name: name.slice(0, 200), data: storage.archiveData },
      ...(mdForRow ? [{ name: mdForRow.name, data: mdForRow.data }] : []),
    ]);

  let kicked: Awaited<ReturnType<typeof kickPanel>>;
  try {
    kicked = await kickPanel(child.id);
  } catch (err) {
    console.log(
      `[work] kickPanel threw on ${child.id}: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
    );
    kicked = { outcome: { status: "refused", reason: "claim" } };
  }
  if (kicked.run) after(kicked.run);
  return okJson(
    {
      id: child.id,
      status: kicked.outcome.status === "running" ? "running" : "received",
      queued:
        kicked.outcome.status === "refused" ? kicked.outcome.reason : null,
      updates: id,
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
