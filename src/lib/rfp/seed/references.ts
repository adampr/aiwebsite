/**
 * REDACTED ON PORT INTO THIS REPO.
 *
 * Upstream this file carried five real client contacts with names, direct
 * dials and work emails. Those are third-party PII, and a git repository is
 * the wrong place for them: history is permanent and this repo is pushed to a
 * remote. The contact fields are therefore "(withheld)" / null here.
 *
 * Nothing is lost. scripts/rfp-seed.ts never wrote these columns anyway, and
 * rfp_references.contact_* is nullable by design (ARCHITECTURE.md §5.17) so
 * staff fill them in-app against the live record rather than against a
 * snapshot that silently ages.
 *
 * The organisation, segment, website and relationship history below are
 * business-directory facts and are kept: they are what makes a reference
 * useful to pick between.
 */
/**
 * Client references, from DOMAIN-RULES D3 and the profile.
 *
 * Separated from facts because they carry contact PII and have their own etiquette: references are
 * called as a final step before contract, out of respect for clients' time, and the proposal must
 * say so.
 *
 * Caring Network is seeded RETIRED with replacedBy pointing at Illinois Humanities. BUILD-PLAN.md
 * calls the retired row "the test case for the retirement logic," and a reference that appears in
 * a sent proposal has to stay resolvable, so it is retired rather than deleted.
 */

import type { Reference } from "@/lib/rfp/content-model";

export const REFERENCES: Reference[] = [
  {
    id: "ref_dc_group",
    organization: "The D/C Group",
    website: "dcexport.com",
    segment: "export and logistics",
    contactName: "(withheld)",
    contactTitle: "(withheld)",
    contactPhone: null,
    contactEmail: null,
    relationshipSince: "June 2010",
    usableWithoutAsking: false,
    notes:
      "16 years, 68 users, Elk Grove Village IL. The single best reference for a no-lock-in pitch.",
    retiredAt: null,
    replacedBy: null,
  },
  {
    id: "ref_nmma",
    organization: "National Marine Manufacturers Association (NMMA)",
    website: "nmma.org",
    segment: "trade association",
    contactName: "(withheld)",
    contactTitle: "(withheld)",
    contactPhone: null,
    contactEmail: null,
    relationshipSince: "July 2017",
    usableWithoutAsking: false,
    notes: "9 years, 86 users, multi-site, Chicago IL. Pairs with Illinois Humanities for nonprofits.",
    retiredAt: null,
    replacedBy: null,
  },
  {
    id: "ref_illinois_humanities",
    organization: "Illinois Humanities",
    website: "ilhumanities.org",
    segment: "nonprofit",
    contactName: "(withheld)",
    contactTitle: "(withheld)",
    contactPhone: null,
    contactEmail: null,
    relationshipSince: "2026",
    usableWithoutAsking: false,
    notes:
      "Added July 2026 during the CHF proposal, replacing Caring Network as the standard nonprofit reference pairing with NMMA.",
    retiredAt: null,
    replacedBy: null,
  },
  {
    id: "ref_eagleone",
    organization: "EagleOne Case Management",
    website: "eagleonecms.com",
    segment: "healthcare",
    contactName: "(withheld)",
    contactTitle: "(withheld)",
    contactPhone: null,
    contactEmail: null,
    relationshipSince: "May 2013",
    usableWithoutAsking: false,
    notes: "13 years, 127 users.",
    retiredAt: null,
    replacedBy: null,
  },
  {
    id: "ref_quada",
    organization: "QuadA",
    website: "quada.org",
    segment: "multi-site healthcare accreditation",
    contactName: "(withheld)",
    contactTitle: "(withheld)",
    contactPhone: null,
    contactEmail: null,
    relationshipSince: "August 2019",
    usableWithoutAsking: false,
    notes: "7 years, 62 users, multi-site.",
    retiredAt: null,
    replacedBy: null,
  },
  {
    id: "ref_caring_network",
    organization: "Caring Network",
    website: null,
    segment: "nonprofit",
    contactName: "(withheld)",
    contactTitle: "(withheld)",
    contactPhone: null,
    contactEmail: null,
    relationshipSince: null,
    usableWithoutAsking: false,
    notes:
      "Retired July 2026 as the standard nonprofit reference. Kept because it appears in proposals already sent, and a reference in a sent proposal must remain resolvable.",
    retiredAt: new Date("2026-07-21T00:00:00.000Z"),
    replacedBy: "ref_illinois_humanities",
  },
];

/**
 * D3's fit table. Nonprofit prospects get Illinois Humanities and NMMA.
 */
export const REFERENCE_FIT: Record<string, string[]> = {
  nonprofit: ["ref_illinois_humanities", "ref_nmma"],
  healthcare: ["ref_eagleone", "ref_quada"],
  "no-lock-in": ["ref_dc_group", "ref_nmma"],
  "multi-site": ["ref_nmma", "ref_quada"],
};

export const REFERENCE_ETIQUETTE_STATEMENT =
  "References are called as a final step before contract, out of respect for our clients' time.";
