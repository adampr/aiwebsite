// The ONE parameterization axis that lets the /work pipeline serve two
// audiences (§5.18): XL.net's public "Our Work" lane (companyId null,
// byte-identical to pre-roadmap behavior) and each client company's private
// "Your Work" lane. Scope is a REQUIRED parameter on every scope-filtering
// function in db.ts — no defaulting, so a forgotten filter is a compile
// error, never a silent cross-tenant leak. Existing call sites pass
// INTERNAL_SCOPE explicitly.

import staticTitles from "./static-titles.json";
import type { SubmissionRow } from "./db";
import { FIRST_PARTY_NAMES } from "./config";
import { companyById } from "@/lib/roadmap/db";

export type WorkScope = { companyId: string | null };

export const INTERNAL_SCOPE: WorkScope = { companyId: null };

export function scopeOf(row: Pick<SubmissionRow, "companyId">): WorkScope {
  return { companyId: row.companyId ?? null };
}

/** Every audience-dependent string and list the panel and the email lane
 * interpolate. The INTERNAL values are the pre-roadmap literals BYTE FOR
 * BYTE (scripts/work-tests.ts pins the load-bearing ones); the company
 * values never name Adam, /admin/work, /work/submit, or the static
 * exhibits. */
export interface ScopeContext {
  scope: WorkScope;
  /** "XL.net" | company display name. */
  orgName: string;
  companyDomain: string | null;
  /** Attribution fallback: "the XL.net team" | "the {orgName} team". */
  teamCredit: string;
  /** Where published cards render. */
  cardsUrl: string;
  /** Panel framing: what kind of card, built where, published where. */
  draftFrame: string;
  /** Disclosure-critic surface line (the gate itself is NOT relaxed). */
  publishSurfaceLine: string;
  /** Hand-authored exhibit titles/facets are a /work-only concept. */
  staticTitles: { titles: string[]; facetLabels: string[] };
  /** Disclosure critic never-hit names; a company's own name is publishable
   * on its own private page. */
  neverHitNames: string[];
}

const INTERNAL_CONTEXT: ScopeContext = {
  scope: INTERNAL_SCOPE,
  orgName: "XL.net",
  companyDomain: null,
  teamCredit: "the XL.net team",
  cardsUrl: "https://ai.xl.net/work",
  draftFrame:
    "a public showcase card for an internal tool built at XL.net, a Chicago managed-IT firm",
  publishSurfaceLine:
    "XL.net is a managed service provider; this card publishes on its public marketing site.",
  staticTitles: {
    titles: staticTitles.titles,
    facetLabels: staticTitles.facetLabels,
  },
  neverHitNames: FIRST_PARTY_NAMES,
};

/** Constants-only for the internal lane (no DB read); one lookup for a
 * company lane. A company row that vanished mid-run degrades to the domain
 * string so the panel still frames correctly. */
export async function scopeContext(scope: WorkScope): Promise<ScopeContext> {
  if (scope.companyId === null) return INTERNAL_CONTEXT;
  const company = await companyById(scope.companyId);
  const orgName = company?.name ?? "your company";
  const domain = company?.domain ?? null;
  return {
    scope,
    orgName,
    companyDomain: domain,
    teamCredit: `the ${orgName} team`,
    cardsUrl: "https://ai.xl.net/roadmap/work",
    draftFrame:
      `a showcase card for an AI-built tool from ${orgName}, published on a ` +
      `private page visible only to ${orgName} employees and XL.net administrators`,
    publishSurfaceLine:
      `XL.net is a managed service provider; this card was submitted by an ` +
      `employee of ${orgName}, a client company, and publishes on a private ` +
      `page visible only to ${orgName} employees and XL.net administrators.`,
    staticTitles: { titles: [], facetLabels: [] },
    neverHitNames: [
      ...FIRST_PARTY_NAMES,
      ...(company ? [company.name, company.domain] : []),
    ],
  };
}
