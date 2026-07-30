// POST (create + kick panel) / GET (list mine) - team work submissions
// (§5.16). @xl.net accounts only. Upload bytes are inspected in memory and
// discarded; only extracted text persists.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { after } from "next/server";
import { brainHealthy } from "@/lib/governance/brain";
import {
  isWorkKind,
  MISSING_ARCH_DOC_MESSAGE,
  WORK_CAPS,
  workSubmissionsEnabled,
} from "@/lib/work/config";
import {
  activeTitleClash,
  countCreatedToday,
  createSubmission,
  mySubmissions,
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
import { okJson, rateLimit, requireXlUser, workError } from "@/lib/work/http";
import { kickPanel } from "@/lib/work/panel";
import { statusView } from "@/lib/work/view";

export async function GET(): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  const limited = rateLimit(`work:list:${user.userId}`, 60, 30);
  if (limited) return limited;
  try {
    await sweepExpiredWork(25);
  } catch {
    // sweep is best-effort on the read path
  }
  const rows = await mySubmissions(user.email);
  return okJson({ submissions: rows.map(statusView) });
}

export async function POST(req: Request): Promise<Response> {
  const user = await requireXlUser();
  if (user instanceof Response) return user;
  if (!workSubmissionsEnabled(process.env))
    return workError(
      "disabled",
      "Submissions are paused right now. Published cards are unaffected.",
      503
    );
  // In-memory CPU guard against upload hammering; the durable daily quota
  // is row-counted below.
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
  const blurb = String(form.get("blurb") ?? "").trim();
  if (
    blurb.length < WORK_CAPS.blurbMinChars ||
    blurb.length > WORK_CAPS.blurbMaxChars
  )
    return workError(
      "invalid_request",
      `Description must be ${WORK_CAPS.blurbMinChars} to ${WORK_CAPS.blurbMaxChars} characters: what it does, who uses it, what it replaced.`,
      400
    );
  // Duplicate-title guard (§5.16, 2026-07-30: the owner triple-submitted the
  // same tool because nothing stopped him). One public page, one active
  // submission per title, from anyone; failed rows never block.
  const norm = normalizeTitle(title);
  if (
    staticTitles.titles.some((t: string) => normalizeTitle(t) === norm) ||
    (await publishedTitleClash(title))
  )
    return workError(
      "duplicate_title",
      "A published /work card already uses this title. Pick a different title.",
      409
    );
  const clash = await activeTitleClash(title);
  if (clash)
    return workError(
      "duplicate_title",
      clash.submitterEmail === user.email
        ? `You already have a submission titled "${title}" in the pipeline (status: ${clash.status}). Check its row below; withdraw it first if you want to resubmit.`
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
        "The public credit must be a single first name, letters only, 2 to 20 characters. Leave it empty to publish as the XL.net team.",
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
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b))
    return workError(
      "invalid_request",
      "That file is not a zip archive. Export a plain .zip and resubmit.",
      400
    );

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
    userId: user.userId,
    email: user.email,
    name: attribution,
    kind,
    title,
    blurb,
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
    // leaves open; map the violation to the same 409.
    if (err instanceof Error && err.message.includes("work_sub_active_title_uq"))
      return workError(
        "duplicate_title",
        `A submission titled "${title}" is already in the pipeline. Check your submissions list below.`,
        409
      );
    throw err;
  }

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
