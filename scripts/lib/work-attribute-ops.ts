// Pure argument + link helpers for the §5.16 attribution lane
// (scripts/work-attribute.ts, `npm run work:attribute`). DB-free at call
// time so scripts/work-attribute-tests.ts drives every branch with no
// database, no brain and no network, the same way
// scripts/lib/work-submit-ops.ts backs work:submit.
//
// NOTHING HERE RE-DERIVES A RULE. The name rule is parseAttribution from
// work-submit-ops.ts, which is the route's own rule and the one work:submit
// applies to --attribution; the uuid shape is isUuid from work/db.ts. This
// module only decides what the operator typed and where the card lives.
//
// NO EM DASHES anywhere in this file (site rule); middots are fine.

import { isUuid } from "../../src/lib/work/db";
import { parseAttribution } from "./work-submit-ops";

export const ATTRIBUTE_USAGE =
  "Usage: npm run work:attribute -- <uuid> <FirstName> [--yes]\n" +
  "       npm run work:attribute -- <uuid> --clear [--yes]";

export type AttributeArgs =
  | { ok: true; id: string; name: string | null; clear: boolean; yes: boolean }
  | { ok: false; message: string };

/** Parse argv (already sliced past node + script). One uuid, then EITHER a
 * single first name OR --clear, never both and never neither: a run that
 * names nothing to write would be an accidental no-op on a public byline.
 * Unknown and repeated flags are refusals rather than silent tolerance,
 * because the only two flags this lane has both change what gets written. */
export function parseAttributeArgs(argv: string[]): AttributeArgs {
  let id: string | null = null;
  let name: string | null = null;
  let clear = false;
  let yes = false;
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      if (arg === "--clear") {
        if (clear) return { ok: false, message: "--clear given twice" };
        clear = true;
      } else if (arg === "--yes") {
        if (yes) return { ok: false, message: "--yes given twice" };
        yes = true;
      } else {
        return { ok: false, message: `unknown flag ${arg}` };
      }
      continue;
    }
    if (id === null) {
      id = arg;
      continue;
    }
    if (name === null) {
      name = arg;
      continue;
    }
    return { ok: false, message: `unexpected extra argument "${arg}"` };
  }
  if (id === null) return { ok: false, message: "a submission uuid is required" };
  if (!isUuid(id)) return { ok: false, message: `"${id}" is not a submission uuid` };
  if (clear && name !== null)
    return {
      ok: false,
      message: "give a first name or --clear, not both",
    };
  if (!clear && name === null)
    return {
      ok: false,
      message:
        "give the first name to credit, or --clear to publish as the XL.net team",
    };
  if (!clear) {
    const parsed = parseAttribution(name);
    // The route's sentence ends "Leave it empty to publish as the XL.net
    // team", which is the form's gesture; here the gesture is --clear.
    if (!parsed.ok)
      return { ok: false, message: `${parsed.message} (Here, use --clear to remove the credit.)` };
    // parseAttribution returns null for an empty string, which the name rule
    // reads as "no credit". Reaching that here means the operator typed an
    // empty argument; --clear is the gesture for that, and it is explicit.
    if (parsed.attribution === null)
      return {
        ok: false,
        message: "the first name is empty; use --clear to remove the credit",
      };
    return { ok: true, id, name: parsed.attribution, clear: false, yes };
  }
  return { ok: true, id, name: null, clear: true, yes };
}

/** Where the card reads its byline, for the operator to check. Public lane
 * (company_id null) is /work; a company row lives on its private §5.18 page.
 * Null when the row has no slug yet: an unpublished row has no card to look
 * at, and the credit simply rides along when it publishes. */
export function creditLink(companyId: string | null, slug: string | null): string | null {
  if (!slug) return null;
  return companyId === null ? `/work#${slug}` : `/roadmap/work#${slug}`;
}

/** The lane in the operator's words, printed before the confirm prompt. */
export function laneLabel(companyId: string | null): string {
  return companyId === null
    ? "public /work (company_id null)"
    : `company lane (company_id ${companyId})`;
}
