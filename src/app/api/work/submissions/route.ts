// POST (create + kick panel) / GET (list mine) - team work submissions
// (§5.16). @xl.net accounts only. Upload bytes are inspected in memory and
// discarded; only extracted text persists.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { after } from "next/server";
import { brainHealthy } from "@/lib/governance/brain";
import {
  isWorkKind,
  MISSING_ARCH_DOC_MESSAGE,
  MISSING_SKILL_DOC_MESSAGE,
  WORK_CAPS,
  workSubmissionsEnabled,
} from "@/lib/work/config";
import {
  countCreatedToday,
  createSubmission,
  mySubmissions,
  sweepExpiredWork,
} from "@/lib/work/db";
import { inspectArchive, inspectBareMd } from "@/lib/work/extract";
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
  if ((await countCreatedToday(user.email)) >= WORK_CAPS.submissionsPerUserPerDay)
    return workError(
      "quota",
      `The limit is ${WORK_CAPS.submissionsPerUserPerDay} submissions per person per day. Try again tomorrow.`,
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

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return workError(
      "invalid_request",
      kind === "program"
        ? "Attach the .zip of your program."
        : "Attach the skill package (.skill or .zip) or its .md file.",
      400
    );
  const name = file.name || "upload";
  const lower = name.toLowerCase();
  const isMd = /\.(md|mdx|markdown)$/.test(lower);
  const isZip = /\.(zip|skill)$/.test(lower);
  if (kind === "program" && !isZip)
    return workError(
      "invalid_request",
      "A program submission must be a .zip archive.",
      400
    );
  if (kind === "skill" && !isZip && !isMd)
    return workError(
      "invalid_request",
      "A skill submission must be a .skill or .zip package, or the skill's .md file.",
      400
    );
  const maxBytes = isMd ? WORK_CAPS.skillMdMaxBytes : WORK_CAPS.uploadMaxBytes;
  if (file.size > maxBytes)
    return workError(
      "invalid_request",
      `That file is too large (limit ${Math.floor(maxBytes / 1_000_000)} MB).`,
      400
    );
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > maxBytes)
    return workError("invalid_request", "That file is too large.", 400);
  if (isZip && !(bytes[0] === 0x50 && bytes[1] === 0x4b))
    return workError(
      "invalid_request",
      "That file is not a zip archive. Export a plain .zip and resubmit.",
      400
    );

  const extracted = isMd
    ? inspectBareMd(name, bytes)
    : await inspectArchive(bytes, kind);
  if (!extracted.ok) {
    // Owner requirement: reject and instruct. 422 carries the fix.
    return workError(extracted.code, extracted.message, 422, {
      ...(extracted.paths ? { paths: extracted.paths } : {}),
      instructions:
        kind === "program" ? MISSING_ARCH_DOC_MESSAGE : MISSING_SKILL_DOC_MESSAGE,
    });
  }

  const row = await createSubmission({
    userId: user.userId,
    email: user.email,
    name: attribution,
    kind,
    title,
    blurb,
    architectureText: kind === "program" ? extracted.docText : null,
    skillMdText: kind === "skill" ? extracted.docText : null,
    fileManifestJson: JSON.stringify(extracted.manifest),
    corpusFilesJson: JSON.stringify(extracted.corpus),
    archiveName: name.slice(0, 200),
    archiveSha256: extracted.archiveSha256,
    archiveBytes: extracted.archiveBytes,
    // Retained until the owner retention email sends on publish (§5.16);
    // non-published rows drop it with the row.
    archiveData: bytes,
  });

  const kicked = await kickPanel(row.id);
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
