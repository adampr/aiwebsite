// POST/DELETE: the optional format-sample upload (§5.12). The user uploads
// an existing company policy (.docx/.pdf/.md/.txt) and every subsequent drafting
// turn mirrors its formatting conventions. Only extracted, injection-screened
// plain text is stored (never the file); it deletes with the project row.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  governanceEnabled,
  STYLE_SAMPLE_TYPES_COPY,
  styleSampleFileError,
} from "@/lib/governance/config";
import {
  clearStyleSample,
  fetchOwnedProject,
  setStyleSample,
} from "@/lib/governance/db";
import { govError, NOT_FOUND, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import { screenInjection } from "@/lib/governance/research";
import {
  extractStyleSampleText,
  sanitizeSampleName,
} from "@/lib/governance/style-sample";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  if (!governanceEnabled(process.env))
    return govError(
      "feature_disabled",
      "New drafting is paused right now, so format samples cannot be added.",
      503
    );
  const { id } = await ctx.params;
  const limited = rateLimit(`gov:sample:${user.userId}`, 60, 10);
  if (limited) return limited;

  const row = await fetchOwnedProject(user.userId, id);
  if (!row) return NOT_FOUND();
  if (row.status === "done")
    return govError(
      "invalid_request",
      "This project is final, so its format sample can no longer be changed.",
      409
    );

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return govError("invalid_request", "Send the file as multipart form data.", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return govError(
      "invalid_request",
      `Attach one ${STYLE_SAMPLE_TYPES_COPY} file.`,
      400
    );
  // Same messages as the client precheck (drag-drop clients and API callers
  // skip the precheck entirely).
  const preError = styleSampleFileError(file.name, file.size);
  if (preError) return govError("invalid_request", preError, 400);

  const extracted = await extractStyleSampleText(
    file.name,
    Buffer.from(await file.arrayBuffer())
  );
  if (!extracted.ok) return govError("invalid_request", extracted.message, 400);

  // The sample is untrusted document content headed for prompts: screen it
  // like research text, and flag the project when lines are dropped.
  const { clean, hits } = screenInjection(extracted.text);
  if (clean.trim().length < 40)
    return govError(
      "invalid_request",
      "Too little of that file's text could be used. Try a copy with ordinary policy text and minimal markup.",
      400
    );

  const name = sanitizeSampleName(file.name);
  const wrote = await setStyleSample({
    userId: user.userId,
    id,
    name,
    text: clean,
    flagged: hits.length > 0,
  });
  if (!wrote) return NOT_FOUND();
  return okJson({ styleSample: { name } });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const limited = rateLimit(`gov:sample:${user.userId}`, 60, 10);
  if (limited) return limited;
  const removed = await clearStyleSample(user.userId, id);
  if (!removed) return NOT_FOUND();
  return new Response(null, { status: 204 });
}
