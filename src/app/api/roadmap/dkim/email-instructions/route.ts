// POST - email the DKIM setup instructions (§5.18 email lane). The recipient is
// HARDCODED to the session's own address; the request body is ignored
// entirely, so there is no relay and no target parameter. Sends mail, so it
// IS gated by the kill switch and carries the tightest caps. The route
// reports the real send outcome: the dialog tells the user "sent" or not,
// and best-effort would lie.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireCompanyMember } from "@/lib/roadmap/access";
import { checkDkim } from "@/lib/roadmap/dkim";
import { dkimCopy, dkimCopyAsText } from "@/lib/roadmap/dkim-copy";
import { notifyDkimInstructions } from "@/lib/roadmap/notify";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

export async function POST(): Promise<Response> {
  const gate = await requireCompanyMember();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;
  const perUser = rateLimit(
    `roadmap:dkim:email:${p.userId}`,
    86_400,
    ROADMAP_CAPS.dkimEmailsPerUserPerDay
  );
  if (perUser) return perUser;
  const perCompany = rateLimit(
    `roadmap:dkim:email:co:${p.company.id}`,
    86_400,
    ROADMAP_CAPS.dkimEmailsPerCompanyPerDay
  );
  if (perCompany) return perCompany;

  const check = await checkDkim(p.company.domain);
  if (!dkimCopy(check).emailable)
    return roadmapError(
      "not_emailable",
      "The check itself could not complete, so there are no instructions to send yet. Hit Recheck first.",
      409
    );
  const sent = await notifyDkimInstructions({
    to: p.email,
    companyDomain: p.company.domain,
    instructionsText: dkimCopyAsText(check),
  });
  if (!sent)
    return roadmapError(
      "send_failed",
      "The email could not be sent right now. The steps shown here still work; try the email again later.",
      502
    );
  return okJson({ sentTo: p.email });
}
