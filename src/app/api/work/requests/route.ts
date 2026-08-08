// POST - create a work request (§5.19). ONE endpoint, two audiences
// (submissions route.ts pattern): xl.net staff land on the internal lane,
// trusted company sessions on their company lane; requireRequestUser
// resolves the scope from the session, never from the body. The 5-open cap
// is enforced by a single-statement INSERT guard in createRequest. Lists are
// server-rendered by the pages; there is deliberately NO GET here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { okJson, rateLimit, workError } from "@/lib/work/http";
import { requireRequestUser } from "@/lib/work/requests-http";
import {
  REQUEST_CAPS,
  validateRequestBody,
} from "@/lib/work/requests-config";
import { createRequest } from "@/lib/work/requests-db";
import { notifyRequestCreated } from "@/lib/work/requests-notify";

export async function POST(req: Request): Promise<Response> {
  const user = await requireRequestUser();
  if (user instanceof Response) return user;
  const limited = rateLimit(`workreq:create:${user.userId}`, 3600, 10);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return workError("invalid_request", "Send the request as JSON.", 400);
  }
  const parsed = validateRequestBody(body);
  if (!parsed.ok) return workError("invalid_request", parsed.message, 400);

  const created = await createRequest(user.scope, {
    userId: user.userId,
    email: user.email,
    name: null,
    title: parsed.title,
    description: parsed.description,
    valueUsd: parsed.valueUsd,
    metrics: parsed.metrics,
  });
  if (!created.ok) {
    return workError(
      "quota",
      `You already have ${REQUEST_CAPS.openPerRequester} open requests. Wait for one to be completed or cancel a pending one first.`,
      429
    );
  }
  // Best-effort: a mail failure never blocks the create.
  await notifyRequestCreated({
    scope: user.scope,
    title: parsed.title,
    requesterEmail: user.email.toLowerCase(),
    valueUsd: parsed.valueUsd,
  });
  return okJson({ id: created.id, status: "pending" }, 201);
}
