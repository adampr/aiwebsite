/**
 * Grounding tests for the stated-staff extractor (ARCHITECTURE.md §5.17).
 *
 *   npm run test:staffcount
 *
 * Pure, no server. Every case here is a documented failure mode from the
 * 2026-08-02 counter-panel: the separator rules and the G-checks are
 * load-bearing in BOTH directions (too loose mints numbers the document
 * never wrote and skips the question; too strict silently degrades to the
 * old question), so both directions are pinned.
 */

import {
  groundStatedStaff,
  minimumAssumption,
  normGroundText,
  parseStaffBound,
  parseStaffRange,
  staffConflictSignals,
  staffMentions,
} from "../src/lib/rfp/staff-count";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got ${a}\n     want ${e}`}`);
}

const g = (raw: unknown, doc: string) => {
  const r = groundStatedStaff(raw, doc);
  return r.staff
    ? { count: r.staff.count, basis: r.staff.basis }
    : (r.discarded ?? null);
};

// ---- must ground -----------------------------------------------------------

check(
  "plain staff count",
  g(
    { count: 120, quote: "Our organization has 120 full time staff.", basis: "staff" },
    "Intro.\nOur organization has 120 full time staff.\nMore."
  ),
  { count: 120, basis: "staff" }
);
check(
  "comma thousands separator",
  g(
    { count: 1200, quote: "We employ 1,200 employees nationwide.", basis: "staff" },
    "We employ 1,200 employees nationwide."
  ),
  { count: 1200, basis: "staff" }
);
check(
  "comma + line-break reflow in the document still grounds",
  g(
    { count: 1200, quote: "We employ 1,200 employees nationwide.", basis: "staff" },
    "We employ 1,\n200 employees nationwide."
  ),
  { count: 1200, basis: "staff" }
);
check(
  "NBSP separator",
  g(
    { count: 1200, quote: "We employ 1\u00A0200 employees.", basis: "staff" },
    "We employ 1\u00A0200 employees."
  ),
  { count: 1200, basis: "staff" }
);
check(
  "narrow-NBSP separator",
  g(
    { count: 1200, quote: "We employ 1\u202F200 employees.", basis: "staff" },
    "We employ 1\u202F200 employees."
  ),
  { count: 1200, basis: "staff" }
);
check(
  "users basis kept when the quote says users",
  g(
    { count: 220, quote: "We have 300 employees, of whom 220 are computer users.", basis: "users" },
    "We have 300 employees, of whom 220 are computer users."
  ),
  { count: 220, basis: "users" }
);
check(
  "users basis COERCED to staff when the quote never says users",
  g(
    { count: 300, quote: "We have 300 employees.", basis: "users" },
    "We have 300 employees."
  ),
  { count: 300, basis: "staff" }
);
check(
  "range case grounds with count null",
  g(
    { count: null, quote: "We employ 100-120 staff across two offices.", basis: "staff" },
    "We employ 100-120 staff across two offices."
  ),
  { count: null, basis: "staff" }
);
check(
  "innocent bidi controls in the document do not block grounding",
  g(
    { count: 120, quote: "We have 120 staff.", basis: "staff" },
    "We have \u202D120\u202C staff."
  ),
  { count: 120, basis: "staff" }
);

// ---- must discard ----------------------------------------------------------

check(
  "ASCII space is NOT a thousands separator (3 500 sq ft)",
  g(
    { count: 3500, quote: "Our 3 500 sq ft facility supports all staff operations.", basis: "staff" },
    "Our 3 500 sq ft facility supports all staff operations."
  ),
  "G5"
);
check(
  "Phase 1 200 users never mints 1200",
  g(
    { count: 1200, quote: "Phase 1 200 users will be migrated in month one.", basis: "users" },
    "Phase 1 200 users will be migrated in month one."
  ),
  "G5"
);
check(
  "currency sigil rejected ($450 fee)",
  g(
    { count: 450, quote: "A $450 per-user administrative fee applies to all staff.", basis: "staff" },
    "A $450 per-user administrative fee applies to all staff."
  ),
  "G5"
);
check(
  "reference number rejected (RFP #450)",
  g(
    { count: 450, quote: "Responses referencing RFP #450 must list staff qualifications.", basis: "staff" },
    "Responses referencing RFP #450 must list staff qualifications."
  ),
  "G5"
);
check(
  "percentage rejected (95% of staff)",
  g(
    { count: 95, quote: "About 95% of staff work on site.", basis: "staff" },
    "About 95% of staff work on site."
  ),
  "G5"
);
check(
  "no population noun (120-day transition)",
  g(
    { count: 120, quote: "A 120-day transition period is required.", basis: "staff" },
    "A 120-day transition period is required."
  ),
  "G6"
);
check(
  "paraphrased quote fails the substring check",
  g(
    { count: 120, quote: "The client employs 120 staff.", basis: "staff" },
    "Our organization has 120 full time staff."
  ),
  "G2"
);
check(
  "words-only number cannot ground digits",
  g(
    { count: 120, quote: "We employ one hundred twenty staff.", basis: "staff" },
    "We employ one hundred twenty staff."
  ),
  "G5"
);
check("zero out of bounds", g({ count: 0, quote: "We have 0 staff.", basis: "staff" }, "We have 0 staff."), "G4");
check(
  "above SMB bound",
  g({ count: 20000, quote: "We have 20000 staff.", basis: "staff" }, "We have 20000 staff."),
  "G4"
);
check(
  "bidi-wrapped digits cannot pass as a different number",
  g(
    { count: 51, quote: "All staff \u202E051\u202C are supported.", basis: "staff" },
    "All staff \u202E051\u202C are supported."
  ),
  "G5"
);
check(
  "range case with no parsable range is discarded (G7)",
  g(
    { count: null, quote: "Our staff count varies seasonally.", basis: "staff" },
    "Our staff count varies seasonally."
  ),
  "G7"
);
check("model returned null", g(null, "whatever"), null);

// ---- normalizer must-not-merge --------------------------------------------

check(
  "comma+space is a list separator, never merged (Section 4, 120)",
  normGroundText("Section 4, 120 staff"),
  "Section 4, 120 staff"
);
check(
  "plain-space grouping never merged",
  normGroundText("Phase 1 200 users"),
  "Phase 1 200 users"
);
check("comma grouping merged", normGroundText("1,200 employees"), "1200 employees");
check(
  "comma+newline reflow merged",
  normGroundText("1,\n200 employees"),
  "1200 employees"
);

// ---- range prefill safety ---------------------------------------------------

check(
  "range picked over a larger street number",
  parseStaffRange("We employ a staff of 300 to 350 at our facility at 450 Main Street."),
  { lo: 300, hi: 350 }
);
check(
  "range picked over a founding year",
  parseStaffRange("Founded in 1998, we now employ 100-120 staff."),
  { lo: 100, hi: 120 }
);
check("between-and phrasing", parseStaffRange("We have between 100 and 120 employees."), {
  lo: 100,
  hi: 120,
});
check("per-location list is not a range", parseStaffRange("HQ 80, warehouse 40."), null);
check("address alone is not a range", parseStaffRange("450 Main Street"), null);
check(
  "descending pair rejected",
  parseStaffRange("From 350 to 300 staff after the divestiture."),
  null
);

// ---- deterministic staff mentions (2026-09-30) ------------------------------
//
// The shape of the RFP that prompted this: a startup practice "with a small
// team of fewer than 10 employees", which the model-selected statedStaff
// (exact digits or an explicit range only) reports as null. The fixture keeps
// every number-bearing line of that document's shape (contract cap, visit
// frequency, points table, schedule, street address) under a made-up client.

const SMALL_SENTENCE =
  "Harbor Lane, NFP is a Chicago-based, women-led startup behavioral health practice with a small team of fewer than 10 employees and contracted clinicians.";
const SMALL_RFP = [
  "Harbor Lane, NFP",
  "# REQUEST FOR PROPOSALS",
  "IT & Technology Back-Office Support Services",
  "Contract: Upon execution - August 31, 2027\tMaximum: $54,000 not to exceed",
  "# 1. Overview",
  `${SMALL_SENTENCE} Harbor Lane is seeking a qualified IT firm or consultant to provide ongoing back-office technology support.`,
  "# 2. Scope of Services",
  "- Apple/Mac support: setup, maintenance, updates, troubleshooting, peripherals, software installation, and employee onboarding/offboarding.",
  "- Remote and onsite support: the ability to provide onsite support at the Chicago office approximately 1–3 times per month, as requested.",
  "- Accounts and access: 1Password, MFA, email and cloud accounts, permissions, account recovery, and secure user access management.",
  "- Policies, procedures, and training: provide staff training on cybersecurity, HIPAA security, phishing, passwords, MFA, remote work.",
  "- Provide responsive support 24/7 for staff during urgent issues.",
  "# 5. Contract & Pricing",
  "The initial contract will run from execution through August 31, 2027 and may not exceed $54,000.",
  "- Your service approach, including how staff request help, remote support, typical response times, and your ability to provide onsite support approximately 1–3 times per month.",
  "- Two references for similar work.",
  "Criterion\tPoints",
  "Experience & qualifications, including Mac support\t25",
  "Cybersecurity/HIPAA security, policies & staff training\t20",
  "Total\t100",
  "RFP issued\tSeptember 18, 2026",
  "Vendor questions due\tSeptember 24, 2026 at 5:00 PM CT",
  "Interviews, if needed\tOctober 5-7, 2026",
  "Harbor Lane, NFP | 3648 W. Belmont Ave., Chicago, IL 60618 | www.example.org",
].join("\n");

const quotes = (doc: string, max?: number) =>
  staffMentions(doc, max).map((m) => m.quote);

check("small-team RFP yields exactly the one sentence", quotes(SMALL_RFP), [
  SMALL_SENTENCE,
]);
check("its bound is 9", parseStaffBound(SMALL_SENTENCE), { max: 9 });
check(
  "and the minimum assumption holds at 15 users",
  minimumAssumption(null, staffMentions(SMALL_RFP), 15),
  { quote: SMALL_SENTENCE }
);
check(
  "every mention grounds against the document it was cut from",
  staffMentions(SMALL_RFP).every((m) =>
    normGroundText(SMALL_RFP).includes(normGroundText(m.quote))
  ),
  true
);
check(
  "a bound above the minimum asks",
  minimumAssumption(null, staffMentions(SMALL_RFP), 8),
  null
);

check("label range is a mention", quotes("Overview\nCurrent Staff: 200 - 250\nLocations: 3"), [
  "Current Staff: 200 - 250",
]);
check(
  "label range above the minimum never assumes",
  minimumAssumption(null, staffMentions("Current Staff: 200 - 250"), 15),
  null
);
check("table row joined by a tab", quotes("Current Staff\t200 - 250"), [
  "Current Staff 200 - 250",
]);
check("label on one line, number on the next", quotes("Number of employees:\n45"), [
  "Number of employees: 45",
]);
check(
  "approximate count is a mention",
  quotes("The district has approximately 45 employees across two offices."),
  ["The district has approximately 45 employees across two offices."]
);
check(
  "a bare count never triggers the assumption on its own",
  minimumAssumption(null, staffMentions("We have 12 employees."), 15),
  null
);
check(
  "small explicit range assumes",
  minimumAssumption(null, staffMentions("We employ 8-12 staff in one office."), 15),
  { quote: "We employ 8-12 staff in one office." }
);
check(
  "up to N users assumes at the boundary",
  minimumAssumption(null, staffMentions("We have up to 15 users."), 15),
  { quote: "We have up to 15 users." }
);
check(
  "a support capacity is not the organization's size",
  minimumAssumption(null, staffMentions("Support covers up to 15 users."), 15),
  null
);
check(
  "conflict: a small bound and a larger count elsewhere asks",
  minimumAssumption(
    null,
    staffMentions(
      "The main office has fewer than 10 employees.\nAcross all sites we support 200 users."
    ),
    15
  ),
  null
);
check(
  "conflict inside one sentence asks",
  minimumAssumption(
    null,
    staffMentions("We have fewer than 10 full-time employees and 45 part-time."),
    15
  ),
  null
);
check(
  "lower bounds are counts, not caps",
  minimumAssumption(null, staffMentions("We have at least 5 employees."), 15),
  null
);
check(
  "wrapped line is re-joined into one sentence",
  quotes("The practice has a small team of fewer than 10\nemployees and contracted clinicians."),
  ["The practice has a small team of fewer than 10 employees and contracted clinicians."]
);
check(
  "duplicates collapse",
  quotes("We have 40 employees.\nFiller line.\nWe have 40  employees.").length,
  1
);
check(
  "the largest count survives the cap",
  quotes(
    [
      "Site A has 3 employees.",
      "Site B has 4 employees.",
      "Site C has 5 employees.",
      "Site D has 6 employees.",
      "In total we support 200 users.",
    ].join("\n"),
    2
  ),
  ["Site A has 3 employees.", "In total we support 200 users."]
);
check(
  "format characters never reach a quote",
  quotes("We have ‮40‬ employees."),
  ["We have 40 employees."]
);
{
  const long =
    "Our organization, which " +
    "has grown steadily over time and ".repeat(12) +
    "now has fewer than 100 employees in the main office, continues to expand.";
  const got = quotes(long);
  check("long sentence is windowed under the cap", got.length === 1 && got[0].length <= 300, true);
  check("and the window never truncates the number", parseStaffBound(got[0] ?? ""), { max: 99 });
}

// Hostile: none of these is a statement of the client's size.
for (const [label, doc] of [
  ["Phase 1 200 users", "Phase 1 200 users will be migrated in month one."],
  ["$450 fee for staff", "A $450 per-user administrative fee applies to all staff."],
  ["RFP #450", "Responses referencing RFP #450 must list staff qualifications."],
  ["95% of staff", "About 95% of staff work on site."],
  ["3 500 sq ft", "Our 3 500 sq ft facility supports all staff operations."],
  ["120-day transition", "A 120-day transition period is required for all staff."],
  ["founding year", "Founded in 1998, the agency trains staff every spring."],
  ["year before a noun", "By 2027 staff will move to the new office."],
  ["street address", "Staff work at 450 Main Street, Suite 200."],
  ["date", "Staff questions are due September 24, 2026 at 5:00 PM CT."],
  ["24/7", "We need 24/7 staff support."],
  ["visit frequency", "Staff need onsite help approximately 1–3 times per month."],
  ["points table", "Staff training\t20"],
  ["numbered heading", "# 4 Staff Qualifications"],
  ["section reference", "See Section 12 staff requirements."],
  ["product number", "All staff use Office 365 users licensing and M365 users groups."],
  ["durations", "Requires 3 years of staff experience and 10 staff hours per week."],
  ["vendor size", "Firms with fewer than 10 employees must name a subcontractor."],
  ["vendor team", "The vendor shall assign up to 3 staff to the account."],
  ["your staff", "Describe how your 12 employees are certified."],
  ["number words", "We employ fewer than ten employees."],
  ["decimal", "We budget 2.5 FTEs for this function."],
  ["per-location list", "HQ 80, warehouse 40."],
] as const) {
  check(`no mention: ${label}`, quotes(doc), []);
}

// ---- bound parsing -----------------------------------------------------------

check("fewer than", parseStaffBound("fewer than 10 employees"), { max: 9 });
check("less than", parseStaffBound("less than 10 staff"), { max: 9 });
check("under", parseStaffBound("under 10 users"), { max: 9 });
check("up to", parseStaffBound("up to 12 users"), { max: 12 });
check("no more than", parseStaffBound("no more than 12 staff"), { max: 12 });
check("at most", parseStaffBound("at most 12 seats"), { max: 12 });
check("N or fewer", parseStaffBound("12 or fewer employees"), { max: 12 });
check("comma thousands", parseStaffBound("fewer than 1,200 employees"), { max: 1199 });
check("bound: currency rejected", parseStaffBound("under $500 per user"), null);
check("bound: percent rejected", parseStaffBound("up to 12% of staff"), null);
check("bound: reference number rejected", parseStaffBound("up to #12 staff"), null);
check("bound: year rejected", parseStaffBound("up to 2027 staff may change"), null);
check("bound: duration rejected", parseStaffBound("staff with less than 5 years of service"), null);
check("bound: number words are not converted", parseStaffBound("fewer than ten employees"), null);
check("bound: space-grouped digits rejected", parseStaffBound("up to 1 200 users"), null);
check("bound: fewer than 1 is nothing", parseStaffBound("fewer than 1 employee"), null);
check("bound: plain count is not a bound", parseStaffBound("We have 12 employees."), null);

// ---- the minimum rule with a model-selected statedStaff ----------------------

const stated = (count: number | null, quote: string) =>
  ({ count, quote, basis: "staff" }) as const;
check(
  "stated count at the minimum assumes",
  minimumAssumption(stated(15, "We have 15 employees."), [], 15),
  { quote: "We have 15 employees." }
);
check(
  "stated count above the minimum asks nothing here",
  minimumAssumption(stated(16, "We have 16 employees."), [], 15),
  null
);
check(
  "stated small range assumes",
  minimumAssumption(stated(null, "We employ 8-12 staff."), [], 15),
  { quote: "We employ 8-12 staff." }
);
check(
  "stated range straddling the minimum does not",
  minimumAssumption(stated(null, "We employ 10-20 staff."), [], 15),
  null
);
check("no evidence at all", minimumAssumption(null, [], 15), null);
check(
  "a nonsense minimum never assumes",
  minimumAssumption(null, staffMentions(SMALL_RFP), 0),
  null
);

// ---- the minimum rule is about the WHOLE organization (refuter round) --------
//
// minimumAssumption no longer prices anything (the generate route seeds only
// an exact grounded count); it picks the primary one-tap answer. It must
// still never read a subset, a capacity, a vendor requirement, a negation, a
// question or a conflicted document as "fits inside the minimum". Each text
// is run the way the workspace runs it (mentions only) AND with the document.

const assume = (doc: string, stated: Parameters<typeof minimumAssumption>[0] = null) => [
  minimumAssumption(stated, staffMentions(doc), 15),
  minimumAssumption(stated, staffMentions(doc), 15, doc),
];

for (const doc of [
  "We are a small team of fewer than 10 employees.",
  "We have fewer than 15 employees.",
  "Our staff of up to 12 people works from one office in the city.",
  "We employ 8-12 staff in one office.",
  "Current Staff: 8 - 12",
  "The number of employees is fewer than 10.",
  SMALL_RFP,
]) {
  const [a, b] = assume(doc);
  check(`whole-organization bound assumes: ${doc.slice(0, 50).replace(/\n/g, " / ")}`, [a !== null, b !== null], [true, true]);
}
check(
  "the small-team RFP still yields its sentence with the document passed",
  minimumAssumption(null, staffMentions(SMALL_RFP), 15, SMALL_RFP),
  { quote: SMALL_SENTENCE }
);
check("and the document shows no larger population", staffConflictSignals(SMALL_RFP, 15), false);

for (const doc of [
  // a part of the organization
  "Our finance department has fewer than 10 employees who need QuickBooks support.",
  "We have 220 employees across the agency. The finance team of fewer than 10 employees handles payroll.",
  "Fewer than 10 remote employees of our 300 staff work from home.",
  "Fewer than 10 of our employees work remotely; the rest of the organization works on site.",
  "Each department has fewer than 10 employees.",
  "We operate 4 branches. Each branch has up to 12 staff.",
  "Each branch has 5-8 employees; we have 40 branches.",
  "We operate 12 locations with up to 10 users per location.",
  "up to 10 users per site across 30 sites",
  "We have 10 to 12 part-time staff and 30 volunteers.",
  "Staff: 4 full-time, up to 6 part-time employees, and 180 volunteers who use shared PCs.",
  "We have 60 workstations and fewer than 10 employees on the IT committee.",
  "We have 250 workstations and under 15 users in IT.",
  "The office supports 10-12 users.",
  "Headquarters staff: up to 12\nField crew: 300",
  "Headquarters staff: up to 12\nField staff: 300",
  // a capacity, a licence count, an access rule
  "No more than 5 employees may hold admin rights.",
  "Training sessions for up to 10 employees at a time.",
  "Training sessions will be held for up to 8 staff members at a time.",
  "Conference room seats up to 12 people.",
  "The board room seats up to 12 people.",
  "The board consists of up to 9 people.",
  "Our board of 9 to 12 people meets quarterly. We employ several hundred staff.",
  "Guest wifi for up to 15 users.",
  "We log fewer than 10 users tickets per day.",
  "No more than 3 users should be affected by any outage.",
  "Up to 10 users will require remote VPN access.",
  "We hold 12 or fewer seats of AutoCAD.",
  "We hold up to 10 licensed users of Adobe; total company size is 400.",
  "Total company size is 400. We hold up to 10 concurrent users on the ERP.",
  "Help desk open to 10 users at once; 5 to 10 employees call daily out of 600.",
  // the responding vendor, with no vendor cue word
  "The selected firm must assign at least 2 and up to 5 staff to our account.",
  "Firms with fewer than 10 employees will not be considered.",
  "The successful company shall dedicate no more than 3 technicians and up to 4 support staff to onboarding.",
  // growth, negation, question
  "We expect to add up to 10 employees next year.",
  "We expect to add up to 10 employees next year to our current staff of 85.",
  "We expect to add up to 5 employees next year. We currently have sixty staff.",
  "We do not have fewer than 10 employees; we have many more.",
  "Do you support organizations with fewer than 15 users?",
  "Since 2019 staff has grown; under 15 employees were here in 2005; today we are much larger.",
  // a larger population in number words
  "We currently have up to 12 staff in the office on any given day, out of a workforce of two hundred.",
  "We have two hundred employees, of whom up to 12 are part-time staff.",
  "The organization employs over one hundred fifty people. Up to 10 users need VPN.",
  "The Association employs approximately forty people. Fewer than 10 employees work remotely.",
  "Our two hundred employees work across three sites; under 15 staff are on site daily.",
  "We employ eighty-five people. Up to 10 users need VPN.",
  "Hundreds of employees; up to 10 users are remote.",
  "Approx. 3 thousand employees; up to 5 users per shared mailbox.",
  "We have 1.2k employees. Up to 12 users share each printer.",
  // a larger population the mention scanner does not read as a count
  "We have 2000 employees. Up to 10 users are administrators.",
  "Our 2024 headcount is 1950. Fewer than 10 employees work in IT.",
  "Staff: 2010\nFewer than 10 employees work in IT.",
  "We have 12000 employees. Under 10 users are admins.",
  "We have 250000 employees. Under 10 users are admins.",
  "We have 1 200 employees. Under 10 users are admins.",
  "We have 1.200 employees. Under 10 users are admins.",
  "We have ２００ employees. Under 10 users are admins.",
  "We have approx. 12 employees. Up to 10 users are remote.",
  "XYZ has a team of 300. Up to 10 users need VPN.",
  "There are 85 of us. Up to 10 users need VPN.",
  "We have 85 workers. Up to 10 users need VPN.",
  "We have 85 team members. Up to 10 users need VPN.",
  "We have 85 dedicated employees. Up to 10 users need VPN.",
  "We have 60 attorneys and 25 paralegals. Fewer than 10 administrative staff support them.",
  "Our 120 clinicians are supported by fewer than 10 employees in the back office.",
  "The district has 40 teachers and up to 12 staff.",
  "We have 180 volunteers and up to 8 employees.",
  "We serve 1,500 students with fewer than 15 staff.",
  "We serve 1,200 students with under 15 administrative staff.",
  "We have ‮01‬ employees at most; up to 10 staff.",
  "10 or fewer employees",
]) {
  check(`no minimum: ${doc.slice(0, 60).replace(/\n/g, " / ")}`, assume(doc), [null, null]);
}

// A legitimate bound beside a larger population elsewhere in the document:
// the mentions cannot carry a word number or an unlisted noun, the document
// scan can, and staffConflictSignals is what a server page passes down.
for (const doc of [
  "We have fewer than 10 employees at the main office.\nOur two hundred field workers use shared tablets.",
  "We have fewer than 10 employees.\nThe firm also has 60 attorneys.",
  "We have fewer than 10 employees.\nOur 2024 headcount is 1950.",
]) {
  check(`document conflict asks: ${doc.slice(30, 80).replace(/\n/g, " / ")}`, assume(doc)[1], null);
  check(`and the signal is exported: ${doc.slice(30, 80).replace(/\n/g, " / ")}`, staffConflictSignals(doc, 15), true);
}
check("a team is a mention and a conflict", quotes("XYZ has a team of 300."), ["XYZ has a team of 300."]);
check(
  "fullwidth digits are read, the quote stays verbatim",
  quotes("We have ２００ employees."),
  ["We have ２００ employees."]
);

// The conflict scan must not read dates, products, durations or the vendor.
for (const doc of [
  "Staff questions are due September 24, 2026 at 5:00 PM CT.",
  "All staff use Office 365 users licensing and Microsoft 365 users groups.",
  "By 2027 staff will move to the new office.",
  "Requires 3 years of staff experience and 40 staff hours per month.",
  "Respond within 30 minutes to all users.",
  "Vendors must have at least 50 employees.",
  "We have 250 workstations and 40 printers for our staff.",
  "Staff training\t20",
  "Phase 1 200 users will be migrated in month one.",
]) {
  check(`no conflict: ${doc.slice(0, 50)}`, staffConflictSignals(doc, 15), false);
}
check("conflict scan: empty text", staffConflictSignals("", 15), false);

// A stated RANGE under the minimum still asks when a mention shows more.
{
  const range = { count: null, quote: "Our main office has 10-12 employees", basis: "staff" } as const;
  check(
    "stated range beside a larger mention asks",
    assume("Our main office has 10-12 employees. We support 85 users across three sites.", range),
    [null, null]
  );
  check(
    "stated range alone still assumes",
    minimumAssumption(range, staffMentions("Our main office has 10-12 employees."), 15),
    { quote: "Our main office has 10-12 employees" }
  );
  check(
    "an exact stated count is not second-guessed by mentions",
    minimumAssumption(
      { count: 12, quote: "We have 12 employees.", basis: "staff" },
      staffMentions("We have 12 employees. We support 85 users."),
      15
    ),
    { quote: "We have 12 employees." }
  );
}

// A bound wrapped right before its number is one sentence again.
check(
  "wrapped bound is re-joined",
  quotes("We have fewer than\n10 employees."),
  ["We have fewer than 10 employees."]
);
check(
  "and a wrapped conflict is too",
  assume("We have fewer than\n10 employees and\n200 Contractors."),
  [null, null]
);
check(
  "a numbered list item is not a wrapped number",
  quotes("The scope covers staff and\n2. Reporting"),
  []
);

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
