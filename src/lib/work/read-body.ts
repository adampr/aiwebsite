// §5.16 shared body reader for BOTH web submission routes (create + update),
// 2026-09-01. The incident that forced it: on 2026-08-27 one submitter's six
// form attempts each delivered a real multipart body (~1s of body receipt per
// nginx) and req.formData() threw every time, deterministically; the classic
// cause is DLP/TLS-inspection middleware rewriting multipart bodies in a way
// undici's parser rejects. The old catch returned "Send the submission as
// multipart form data", meaningless to a form user whose form did send
// multipart, and the failure was invisible to the owner (a 14-day nginx line
// was the only trace). This module fixes all three ends at once: it accepts
// the raw fallback transport the form retries with (raw-package.ts; an opaque
// binary body is what middleboxes do NOT mangle), it logs the one forensic
// line, and it mirrors the episode into the reported_issues ledger.
//
// The routes' Content-Length prechecks run BEFORE this reader is called, so
// the size gate covers the raw arrayBuffer() read exactly as it covers
// formData()'s buffering. Everything downstream of the returned FormData is
// byte-identical in both routes: the raw path builds the SAME keys the
// multipart path produces (title, blurb, attribution, timeSavedHours, file,
// skillMd) and the file-level size checks run on the constructed File objects.

import { reportUnreadableUploadIssue } from "@/lib/report-issue";
import {
  MULTIPART_UNREADABLE_MESSAGE,
  RAW_UNREADABLE_MESSAGE,
  notMultipartMessage,
} from "@/lib/work/config";
import {
  WORK_RAW_CONTENT_TYPE,
  decodeRawWorkPackage,
} from "@/lib/work/raw-package";

export type WorkBodyLane = "create" | "update";

export type WorkBodyResult =
  | { ok: true; form: FormData }
  | {
      ok: false;
      /** Feed these straight into workError(code, message, 400). */
      code: "invalid_request" | "body_unreadable";
      message: string;
    };

/** Which refusal a failed MULTIPART-path body read earns, decided by what
 * the content-type header proves about the caller. Pure and exported so
 * test:worksubmit can pin the split without touching the ledger. A multipart
 * header means the right shape was sent and the BODY arrived garbled:
 * body_unreadable, the copy that explains the transit-mangling and names the
 * form's automatic retry (never claiming one already happened: this sentence
 * is what a retry-less script reads, and the form swallows it and retries).
 * Anything else is a script speaking the wrong format: invalid_request, the
 * copy that teaches -F, lane-aware because the update route refuses a typed
 * title so its example must not show one. The raw transport's failures are
 * NOT decided here; they always refuse body_unreadable with
 * RAW_UNREADABLE_MESSAGE, the only copy allowed to say "tried twice". */
export function bodyRefusalFor(
  contentType: string,
  lane: WorkBodyLane
): {
  code: "invalid_request" | "body_unreadable";
  message: string;
} {
  return contentType.toLowerCase().includes("multipart/form-data")
    ? { code: "body_unreadable", message: MULTIPART_UNREADABLE_MESSAGE }
    : { code: "invalid_request", message: notMultipartMessage(lane) };
}

/** The forensic line + the ledger mirror, then the typed refusal. ONE log
 * line per failure (the [work] size-refusal precedent: these are the only
 * other 4xx branches that log). contentType is JSON-stringified because a
 * multipart header value carries spaces and quotes in its boundary; quoting
 * keeps the line one token per field (the size-refusal filename rule). */
function refuse(
  lane: WorkBodyLane,
  submitterEmail: string,
  req: Request,
  err: unknown,
  outcome: { code: "invalid_request" | "body_unreadable"; message: string }
): WorkBodyResult {
  const contentType = req.headers.get("content-type") ?? "";
  const contentLength = req.headers.get("content-length") ?? "absent";
  console.log(
    `[work] body-unreadable ${lane} submitter=${submitterEmail} contentType=${JSON.stringify(contentType)} contentLength=${contentLength} err=${String(err).slice(0, 200)}`
  );
  // Recording is subordinate (report-issue.ts contract): never throws, and
  // this function does not branch on it. Episodic key = (reason class, lane).
  reportUnreadableUploadIssue({
    key: `work-intake:body-unreadable:web-${lane}`,
    subject: `A /work upload body could not be read (web ${lane})`,
    detail: [
      `submitter ${submitterEmail}`,
      `content-type: ${contentType || "(none)"}`,
      `content-length: ${contentLength}`,
      `parser error: ${String(err).slice(0, 500)}`,
      `refused as ${outcome.code}.`,
    ].join("\n"),
  });
  return { ok: false, ...outcome };
}

/**
 * Try the request body as a FormData, whichever wire format carried it. The
 * raw transport is keyed STRICTLY on its own content type, so the multipart
 * path (and its error behavior) is byte-identical for every existing caller.
 */
export async function readWorkBody(
  req: Request,
  lane: WorkBodyLane,
  submitterEmail: string
): Promise<WorkBodyResult> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes(WORK_RAW_CONTENT_TYPE)) {
    let body: Uint8Array<ArrayBuffer>;
    try {
      body = new Uint8Array(await req.arrayBuffer());
    } catch (err) {
      return refuse(lane, submitterEmail, req, err, {
        code: "body_unreadable",
        message: RAW_UNREADABLE_MESSAGE,
      });
    }
    const decoded = decodeRawWorkPackage(body);
    if (!decoded.ok)
      return refuse(
        lane,
        submitterEmail,
        req,
        `raw framing: ${decoded.error}`,
        { code: "body_unreadable", message: RAW_UNREADABLE_MESSAGE }
      );
    // The exact keys the multipart path produces; a field absent from the
    // metadata stays absent from the FormData ("absent = not sent", which is
    // what parseTimeSavedHours and the update route's title guard rely on).
    const form = new FormData();
    for (const [k, v] of Object.entries(decoded.fields))
      if (v !== undefined) form.set(k, v);
    form.set("file", new File([decoded.file.bytes], decoded.file.name));
    if (decoded.doc)
      form.set("skillMd", new File([decoded.doc.bytes], decoded.doc.name));
    return { ok: true, form };
  }
  try {
    return { ok: true, form: await req.formData() };
  } catch (err) {
    return refuse(
      lane,
      submitterEmail,
      req,
      err,
      bodyRefusalFor(contentType, lane)
    );
  }
}
