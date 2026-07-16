// GET (poll) / DELETE — one governance project (§5.12). GET is the poll
// target and never mutates anything (claims happen on POST /research only);
// reads work even when the feature kill switch is off.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  deleteOwnedProject,
  fetchOwnedProject,
} from "@/lib/governance/db";
import { NOT_FOUND, okJson, rateLimit, requireUser } from "@/lib/governance/http";
import { toProjectView } from "@/lib/governance/view";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const limited = rateLimit(`gov:poll:${user.userId}`, 60, 60);
  if (limited) return limited;
  const row = await fetchOwnedProject(user.userId, id);
  if (!row) return NOT_FOUND();
  return okJson(toProjectView(row));
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const limited = rateLimit(`gov:delete:${user.userId}`, 86_400, 10);
  if (limited) return limited;
  const deleted = await deleteOwnedProject(user.userId, id);
  if (!deleted) return NOT_FOUND();
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store, private" },
  });
}
