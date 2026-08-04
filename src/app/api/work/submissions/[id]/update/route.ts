// POST - propose an UPDATE to a published community card (§5.16
// admin-mediated updates, 2026-08-03). Creates a NEW row with parent_id set;
// title and kind are PINNED to the predecessor (renames stay admin-CLI-only)
// and the panel result parks as pending_approval for the admin swap click.
// ONE exception (owner ruling 2026-08-03): a Google-verified admin session
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
import { WORK_CAPS, workSubmissionsEnabled, type WorkKind } from "@/lib/work/config";
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
} from "@/lib/work/extract";
import {
  okJson,
  rateLimit,
  requireXlUser,
  verifiedWebAdmin,
  workError,
} from "@/lib/work/http";
import { kickPanel } from "@/lib/work/panel";

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () =>
  workError("not_found", "That submission does not exist.", 404);

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
  const sentKind = String(form.get("kind") ?? "").trim();
  if (sentKind && sentKind !== kind)
    return workError(
      "invalid_request",
      `The published card "${row.title}" is a ${kind === "skill" ? "CoWork Skill" : "Code program"}, so an update to it must be one too. Resubmit with the matching package type.`,
      400
    );
  const blurb = String(form.get("blurb") ?? "").trim();
  if (
    blurb.length < WORK_CAPS.blurbMinChars ||
    blurb.length > WORK_CAPS.blurbMaxChars
  )
    return workError(
      "invalid_request",
      `Description must be ${WORK_CAPS.blurbMinChars} to ${WORK_CAPS.blurbMaxChars} characters: what changed and what it does now.`,
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

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return workError(
      "invalid_request",
      kind === "program"
        ? "Attach the .zip of the updated program."
        : "Attach the updated Skill package (.skill or .zip).",
      400
    );
  const name = file.name || "upload";
  if (!/\.(zip|skill)$/.test(name.toLowerCase()))
    return workError(
      "invalid_request",
      kind === "program"
        ? "A Code program update must be a .zip archive."
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
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b))
    return workError(
      "invalid_request",
      "That file is not a zip archive. Export a plain .zip and resubmit.",
      400
    );
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
  if (!extracted.ok)
    return workError(extracted.code, extracted.message, 422, {
      ...(extracted.paths ? { paths: extracted.paths } : {}),
    });
  let docText = extracted.docText;
  let corpus = extracted.corpus;
  let mdMeta:
    | { name: string; sha256: string; bytes: number; data: Buffer }
    | undefined;
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
      architectureText: kind === "program" ? docText : null,
      skillMdText: kind === "skill" ? docText : null,
      fileManifestJson: JSON.stringify(extracted.manifest),
      corpusFilesJson: JSON.stringify(corpus),
      archiveName: name.slice(0, 200),
      archiveSha256: extracted.archiveSha256,
      archiveBytes: extracted.archiveBytes,
      archiveData: bytes,
      md: mdMeta,
      parentId: id,
      // The ONLY call site that may arm this (web session, Google-verified
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
    },
    202
  );
}
