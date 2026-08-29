// Pure argument parsing and validation for `npm run work:credit` (§5.16/
// §5.18 exhibit credits, owner ruling 2026-08-29). No DB, no fs, no env, so
// scripts/roadmap-tests.ts drives every branch without a database.
//
// The one job worth stating: an exhibit credit is keyed on a /work SECTION
// ID, and a mistyped id fails CLOSED and SILENTLY. scorecardRows filters
// credits against the generated anchor list, so `ticket-scribe` (which does
// not exist) is indistinguishable from a retired exhibit: the write
// succeeds, nothing errors, and the colleague still reads 0 exhibits, which
// is the exact bug the table was built to fix. So the id is validated HERE,
// at the write edge, against the same generated list the reader uses.

/** RFC 5321's practical ceiling, checked before anything looks at shape. */
const EMAIL_MAX_CHARS = 254;

export type CreditCommand = "add" | "remove" | "list";

export type CreditArgs = {
  cmd: CreditCommand;
  anchorId: string;
  email: string;
  by: string;
  yes: boolean;
};

export type CreditParse =
  | { ok: true; args: CreditArgs }
  | { ok: false; error: string };

/** Case-fold and trim to the stored form. The unique index is on
 * (anchor_id, lower(email)) and every read groups on lower(email), so the
 * write edge must agree with both or one person becomes two rows that count
 * twice. */
export function normalizeCreditEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validate an exhibit credit against the CURRENT page.
 *
 * @param anchorId     the /work section id the caller typed
 * @param email        the builder's address, pre-normalization
 * @param validAnchors the generated anchor list (staticTitles.anchorIds)
 * @param laneDomains  the domains a credit may name (staff lane only)
 * @param allowRetired ADD must refuse an id that is not on the page (a typo
 *                     fails closed and silently, the person reads 0). REMOVE
 *                     must ACCEPT one: retiring the credit of an exhibit
 *                     that has already left page.tsx is the normal cleanup
 *                     order (page removal deploys first, then the credit is
 *                     retired), and a live-list check there would make dead
 *                     rows permanent. Found by the 2026-08-29
 *                     exhibit-to-team-card conversion round.
 */
export function validateCredit(opts: {
  anchorId: unknown;
  email: unknown;
  validAnchors: readonly string[];
  laneDomains: readonly string[];
  allowRetired?: boolean;
}): { ok: true; anchorId: string; email: string } | { ok: false; error: string } {
  const { validAnchors, laneDomains } = opts;
  if (typeof opts.anchorId !== "string" || opts.anchorId.trim() === "")
    return { ok: false, error: "an exhibit id is required" };
  const anchorId = opts.anchorId.trim();
  if (opts.allowRetired && !/^[a-z0-9][a-z0-9-]*$/.test(anchorId))
    return {
      ok: false,
      error: `"${anchorId}" is not a section-id shape (lowercase letters, digits, hyphens)`,
    };
  if (!opts.allowRetired && !validAnchors.includes(anchorId)) {
    // Name the near misses rather than dumping 26 ids: a typo is usually one
    // character or one word away from the real thing.
    const near = validAnchors
      .filter(
        (a) =>
          a.includes(anchorId) ||
          anchorId.includes(a) ||
          a.replace(/-/g, "") === anchorId.replace(/-/g, "")
      )
      .slice(0, 5);
    return {
      ok: false,
      error:
        `"${anchorId}" is not a section id on the /work page, so a credit for it would count for nobody.` +
        (near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : "") +
        ` The ids come from src/lib/work/static-titles.json (generated from src/app/work/page.tsx); run with "list" to see the ones already credited.`,
    };
  }
  if (typeof opts.email !== "string" || opts.email.trim() === "")
    return { ok: false, error: "an email address is required" };
  const raw = opts.email.trim();
  if (raw.length > EMAIL_MAX_CHARS)
    return { ok: false, error: "that email address is too long" };
  const email = normalizeCreditEmail(raw);
  // Deliberately NOT a character allowlist (the §5.16 transfer rule): what is
  // rejected is the shape that cannot be a deliverable address at all.
  const at = email.split("@");
  const localPart = at[0] ?? "";
  const domain = at.length === 2 ? (at[1] ?? "") : null;
  const badDots =
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    domain === null ||
    domain.startsWith(".") ||
    domain.includes("..");
  if (
    domain === null ||
    !localPart ||
    /\s/.test(email) ||
    localPart.startsWith('"') ||
    badDots
  )
    return {
      ok: false,
      error: `"${raw}" does not look like an email address. Use the person's full work address.`,
    };
  if (!laneDomains.includes(domain))
    return {
      ok: false,
      error: `an exhibit credit names an XL.net builder, so the address must be at ${laneDomains.join(", ")}.`,
    };
  return { ok: true, anchorId, email };
}

/** `work:credit list | add <anchor> <email> --by <admin> | remove <anchor> <email> --by <admin>` */
export function parseCreditArgs(argv: string[]): CreditParse {
  let by: string | null = null;
  let yes = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yes") yes = true;
    else if (a === "--by") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        return { ok: false, error: "--by needs an email address" };
      if (by !== null) return { ok: false, error: "--by given twice" };
      by = v;
    } else if (a.startsWith("--"))
      return { ok: false, error: `unknown flag ${a}` };
    else rest.push(a);
  }
  const cmd = rest[0];
  if (cmd !== "add" && cmd !== "remove" && cmd !== "list")
    return { ok: false, error: "first argument must be list, add or remove" };
  if (cmd === "list") {
    if (rest.length > 1)
      return { ok: false, error: "list takes no further arguments" };
    return { ok: true, args: { cmd, anchorId: "", email: "", by: "", yes } };
  }
  if (rest.length !== 3)
    return {
      ok: false,
      error: `${cmd} takes exactly <exhibit-id> <email>`,
    };
  // Required, and required for BOTH verbs: updated_by_email is the durable
  // answer to "who says so" for a colleague who asks to be uncredited, and a
  // removal with no recorded actor is the half of that record people
  // actually go looking for later.
  if (by === null)
    return { ok: false, error: `${cmd} needs --by <your xl.net address>` };
  return {
    ok: true,
    args: { cmd, anchorId: rest[1]!, email: rest[2]!, by, yes },
  };
}
