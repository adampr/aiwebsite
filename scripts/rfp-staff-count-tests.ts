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
  normGroundText,
  parseStaffRange,
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

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
