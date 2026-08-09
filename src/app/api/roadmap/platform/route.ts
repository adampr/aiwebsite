// POST - save one of the three phase 09/10 singletons (§5.20): the API
// proxy, the developer-VM environments, or the lakehouse. Admin-only in
// both lanes; the shared gate carries the staff branch and the kill switch.
//
// SAVE FIRST, CHECK SECOND, and never the other way round. The owner's rule
// is that an address we cannot reach is still SAVED and simply does not
// count, so the row is committed before a single packet leaves the box. If
// the check then fails, times out, or the request dies mid-flight, the
// admin's typing survives and the Retry button has something to retry.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { saveSingletonLink } from "@/lib/roadmap/db";
import {
  limitPlatformWrite,
  limitUrlCheck,
  requirePlatformAdmin,
} from "@/lib/roadmap/platform-http";
import { publicRow, verifyRow } from "@/lib/roadmap/platform-check";
import { okJson, roadmapError } from "@/lib/roadmap/http";
import {
  parseEnvironmentsField,
  parseUrlField,
} from "@/lib/roadmap/validate";

const SINGLETON_KINDS = ["api_proxy", "dev_vms", "lakehouse"] as const;
type SingletonKind = (typeof SINGLETON_KINDS)[number];

function isSingletonKind(v: unknown): v is SingletonKind {
  return (
    typeof v === "string" &&
    (SINGLETON_KINDS as readonly string[]).includes(v)
  );
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { actor } = gate;

  const limited = limitPlatformWrite(actor);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return roadmapError("invalid_request", "Send JSON.", 400);
  }

  const kind = body.kind;
  if (!isSingletonKind(kind))
    return roadmapError("invalid_request", "Unknown section.", 400);

  const url = parseUrlField(body.url);
  if (!url.ok) return roadmapError("invalid_request", url.message, 400);
  const docs = parseUrlField(body.docsUrl);
  if (!docs.ok) return roadmapError("invalid_request", docs.message, 400);

  // Developer VMs is the one component with no endpoint of its own: its
  // input is the environment list. Storing a URL there would be silently
  // dropped by the migration's envs/shape CHECKs, so refuse it plainly.
  const envs = parseEnvironmentsField(body.environments);
  if (!envs.ok) return roadmapError("invalid_request", envs.message, 400);

  if (kind === "dev_vms") {
    if (url.url)
      return roadmapError(
        "invalid_request",
        "Developer VMs are described by their hosting environments, not by a single address.",
        400
      );
  } else if (envs.environments.length) {
    return roadmapError(
      "invalid_request",
      "Hosting environments belong to the Developer VMs section.",
      400
    );
  }

  // An all-empty save creates a row that can never count and that the UI
  // then reports as "Saved, not confirmed yet" forever, with no way to
  // clear it. Refuse it instead: there is nothing to save.
  const hasSomething =
    kind === "dev_vms"
      ? envs.environments.length > 0 || !!docs.url
      : !!url.url || !!docs.url;
  if (!hasSomething)
    return roadmapError(
      "invalid_request",
      kind === "dev_vms"
        ? "Pick at least one hosting environment, or add the instructions link."
        : "Add an address or an instructions link before saving.",
      400
    );

  const saved = await saveSingletonLink({
    scope: actor.scope,
    kind,
    url: kind === "dev_vms" ? null : url.url,
    docsUrl: docs.url,
    environments: kind === "dev_vms" ? envs.environments : null,
    addedByUserId: actor.userId,
    addedByEmail: actor.email,
  });

  // The check is best-effort and budget-bounded, and the limiter is spent
  // PER FIELD inside verifyRow (a field is what costs outbound requests).
  // A refusal is NOT an error here: the row is already saved and simply
  // stays unchecked until the admin retries, which is exactly the state the
  // UI renders.
  const checked = await verifyRow(actor.scope, saved, {
    spend: () => limitUrlCheck(actor),
    internalDomain: actor.internalDomain,
  }).catch(() => ({ row: saved, skipped: true }));
  const row = checked.row;
  const checkSkipped = checked.skipped;

  return okJson({ row: publicRow(row, actor.internalDomain), checkSkipped });
}
