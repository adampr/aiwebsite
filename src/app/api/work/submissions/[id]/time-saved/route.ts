// POST - set or CLEAR the submitter's own "time saved per month" figure on
// one submission (§5.16 / §5.18, owner ask 2026-08-27: "allow anyone that
// submitted work to either at submission (optionally) or afterwards under
// their submissions to submit a new field"). This file is the AFTERWARDS
// half; the create route carries the optional field at submission time.
//
// Deliberately status-BLIND, which no other §5.16 verb is. Retry refuses a
// published row, update only accepts one, transfer refuses a live run: those
// all move a row through the pipeline. This one edits a fact ABOUT the work,
// and the fact is usually only learned after the tool has been in use for a
// month, so the published row is the main case rather than the edge one.
// Nothing here re-runs the panel, sends mail, or changes a status; the
// number is SELF-REPORTED and never panel-verified, which is why the card
// prints it attributed to the submitter.
//
// requireWorkUser, not requireXlUser: the editor is offered on both
// /work/submit (staff lane) and /roadmap/work (a company's own members), so
// gating on xl.net would ship a control that 403s for half the people who
// can see it.
//
// CSRF: "/api/work" is already listed in src/proxy.ts protectedPrefixes, so
// this route inherits the same-origin check on POST with no edit there.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { setTimeSaved, submissionListRowById } from "@/lib/work/db";
import {
  okJson,
  rateLimit,
  requireWorkUser,
  verifiedWebAdmin,
  workError,
} from "@/lib/work/http";
import { parseTimeSavedHours } from "@/lib/work/time-saved";
import { sameEmail } from "@/lib/work/transfer";

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () =>
  workError("not_found", "That submission does not exist.", 404);

const BAD_BODY = () =>
  workError("invalid_request", 'Send JSON like {"hours": 6.5}.', 400);

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const user = await requireWorkUser();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  // 20/min. This is one small UPDATE with no brain call, no mail and no file
  // work, so the limiter is here to bound a stuck client rather than to
  // ration a scarce resource; a person correcting a figure a few times in a
  // row must never meet it. A per-MINUTE window on purpose (the 2026-08-09
  // directory lockout: the shared limiter's window is FIXED from its first
  // request, so an hour-long bucket keeps refusing for the rest of the hour
  // once it fills).
  const limited = rateLimit(`work:timesaved:${user.userId}`, 60, 20);
  if (limited) return limited;

  // .catch(() => null), then an explicit object test. req.json() RESOLVES
  // (it does not throw) on the literal body `null`, so the tempting
  // `const { hours } = await req.json()` shape 500s on an empty body - the
  // exact defect a refuter caught on the roadmap docs route, which now
  // carries a `?? {}` guard for the same reason. A body that is not JSON at
  // all throws instead and lands in the same 400. Arrays are refused too:
  // `[]` has no
  // `hours` property, so it would otherwise read as "clear this figure".
  const body: unknown = await req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return BAD_BODY();

  const row = await submissionListRowById(id);
  // ONE identical 404 for missing and not-yours ([id] GET and transfer
  // precedent): a separate 403 would make this route an oracle for whether
  // any given uuid exists.
  //
  // THE TENANCY GATE IS THIS LINE. submissionListRowById is NOT scope
  // filtered - it looks a row up by id alone, across the staff lane and
  // every company - so a company session reaching another tenant's row is
  // stopped by the ownership check here and by nothing else. setTimeSaved is
  // scope-blind by design and will happily write whatever id it is handed.
  //
  // sameEmail, not raw equality (§5.16 transfer round): a moved row stores
  // the address its mover typed, so "Jane@xl.net" must still match a row
  // stored as "jane@xl.net" or she 404s on her own submission.
  // verifiedWebAdmin, not bare isAdmin (§5.18): the Microsoft common-tenant
  // lane can mint an isAdmin-passing session (nOAuth; see the head of
  // src/lib/rfp/access.ts), and company-private rows are reachable here.
  if (!row || (!sameEmail(row.submitterEmail, user.email) && !verifiedWebAdmin(user)))
    return NOT_FOUND();

  // The SAME parser the form and the create route use, so a value one lane
  // accepts can never be a value another refuses. Hours in, minutes stored;
  // 0 or empty parses to null, which is how a wrong figure comes back off a
  // live card.
  const parsed = parseTimeSavedHours((body as { hours?: unknown }).hours);
  if (!parsed.ok) return workError("invalid_request", parsed.message, 400);

  const saved = await setTimeSaved({ id, minutes: parsed.minutes });
  // A delete racing the save: report the row as gone rather than a save that
  // wrote nothing, which would leave the editor showing a number no row
  // holds.
  if (!saved) return NOT_FOUND();

  // The public /work page is ISR; the company Your Work page is
  // force-dynamic and needs nothing. Flush only for a PUBLISHED staff-lane
  // row, because that is the only case where a card on a cached page is
  // showing the old figure. The 300 s revalidate floor is the fallback if
  // this throws (the reorder and DELETE routes take the same shape).
  if (row.status === "published" && row.companyId === null) {
    try {
      const { revalidatePath } = await import("next/cache");
      revalidatePath("/work");
    } catch {
      // ISR revalidate=300 is the floor
    }
  }

  // Echo the STORED minutes, not the submitted hours: the client renders
  // from this, and rounding (0.005 hours becomes 1 minute) happens in the
  // parser, so returning the input would paint a value the database does
  // not hold.
  return okJson({ timeSavedMinutes: parsed.minutes });
}
