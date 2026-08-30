// Pure argv parsing + display helpers for the §5.16 ops re-run script
// (scripts/work-panel-rerun.ts). Deliberately DB-free: test:work unit-tests
// every branch here without a database, and the script stays a thin loop
// around kickPanel and the db.ts ops it already used. The 2026-08-30 flags
// (owner directive: "present tense this and other cards that remain", "with
// no notify on those 26 past tense fixes") live here so their rules are
// pinned by tests, not prose:
//
//   --no-notify      the re-run's outcome sends NO email of any kind; the
//                    row outcome still writes, and the operator watching
//                    this console is the notification.
//   --keep-position  the card must not move. On a re-run, the re-published
//                    row keeps the published_at and display_rank captured
//                    before the hold; on EITHER branch the script refuses a
//                    slug-changing retitle under this flag (placements.ts
//                    keys bays on the slug, DISCLOSURE-ALLOWLIST seat,
//                    2026-08-30). Opt-in ALWAYS: absent means today's
//                    fresh stamp.
//
// Both combine with each other and with --title. --retitle-only refuses
// --no-notify (that branch never emails, so accepting the flag would
// promise a suppression that changes nothing; work:transfer precedent: a
// flag that means nothing is refused, not ignored) but accepts
// --keep-position as the stay-put assertion described above.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RerunArgs = {
  /** Submission uuid, lowercased. */
  id: string;
  /** Trimmed new title, or null when --title was not given. */
  title: string | null;
  retitleOnly: boolean;
  /** --no-notify: suppress every email on the re-run's outcome. */
  noNotify: boolean;
  /** --keep-position: restore published_at + display_rank on publish. */
  keepPosition: boolean;
  yes: boolean;
};

export type RerunArgsParse =
  | { ok: true; args: RerunArgs }
  | { ok: false; error: string };

/**
 * `<uuid> [--title "New Title"] [--retitle-only] [--no-notify]
 * [--keep-position] [--yes]`. Unknown flags and stray positionals are
 * refused by name: a typo like --keep-postion silently ignored would re-run
 * 26 cards with exactly the side effects the operator flagged against.
 */
export function parseRerunArgs(argv: string[]): RerunArgsParse {
  let id: string | null = null;
  let title: string | null = null;
  let retitleOnly = false;
  let noNotify = false;
  let keepPosition = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--retitle-only") retitleOnly = true;
    else if (a === "--no-notify") noNotify = true;
    else if (a === "--keep-position") keepPosition = true;
    else if (a === "--yes") yes = true;
    else if (a === "--title") {
      const v = argv[i + 1];
      if (v === undefined)
        return { ok: false, error: "--title needs a value" };
      // A following flag is a dropped value, not a title: accepting it here
      // would RENAME the card to "--no-notify" and, worse, leave the flag it
      // swallowed unset, firing exactly the side effects the operator
      // flagged against (refutation 2026-08-30).
      if (v.startsWith("--"))
        return { ok: false, error: `--title needs a value; got the flag ${v}` };
      if (title !== null) return { ok: false, error: "--title given twice" };
      title = v.trim();
      if (title === "")
        return { ok: false, error: "--title needs a non-empty value" };
      i++;
    } else if (a.startsWith("--"))
      return { ok: false, error: `unknown flag ${a}` };
    else if (id === null) id = a;
    else return { ok: false, error: `unexpected argument ${a}` };
  }
  if (!id || !UUID_RE.test(id))
    return { ok: false, error: "a submission uuid is required" };
  if (retitleOnly && title === null)
    return { ok: false, error: "--retitle-only requires --title" };
  if (retitleOnly && noNotify)
    return {
      ok: false,
      error:
        "--no-notify only means something for a re-run; the retitle branch never emails",
    };
  // --retitle-only WITH --keep-position is allowed: the script treats the
  // flag as "this card must not move", so on the retitle branch it refuses
  // a slug-changing new title (a placed card would fall out of its bay).
  return {
    ok: true,
    args: {
      id: id.toLowerCase(),
      title,
      retitleOnly,
      noNotify,
      keepPosition,
      yes,
    },
  };
}

/** First sentence of a card summary, for the before/after tense line the
 * operator reads instead of opening /work. Ends at the first . ! or ? that
 * closes a sentence (a closing quote or bracket may follow); a summary with
 * no terminator comes back whole. */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^[\s\S]*?[.!?](?=["')\]]*(?:\s|$))/.exec(t);
  return (m ? m[0] : t).trim();
}

/** row.cardJson to the summary's first sentence, or null when there is no
 * stored card copy to read (a held row after holdPublishedForRerun nulled
 * card_json, a failed row, junk bytes). */
export function summaryFirstSentence(cardJson: string | null): string | null {
  if (!cardJson) return null;
  try {
    const parsed: unknown = JSON.parse(cardJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const summary = (parsed as Record<string, unknown>).summary;
    if (typeof summary !== "string" || summary.trim() === "") return null;
    return firstSentence(summary);
  } catch {
    return null;
  }
}

/** The dry plan line printed BEFORE the confirm prompt: one line stating,
 * for each of the three side effects (emails, position, slug), whether it
 * WILL happen on this re-run. Pure so test:work pins every combination. */
export function rerunPlanLine(opts: {
  noNotify: boolean;
  keepPosition: boolean;
  /** --title was given AND its derived slug differs from the current
   * title's (the script computes this; a company-lane row's slug is
   * id-derived and never changes, so it passes false). */
  slugChanges: boolean;
  /** The row's published_at as captured before the hold (null when the row
   * was never published). */
  publishedAt: Date | null;
  /** The row's display_rank as captured before the hold. */
  displayRank: number | null;
  /** The row's current slug (null when the row was never published). */
  slug: string | null;
}): string {
  const emails = opts.noNotify
    ? "emails: NONE will be sent (--no-notify: notifyPublished owner+submitter, archive retention, held and failure mail are all suppressed)"
    : "emails: WILL send on the outcome (notifyPublished to owner and submitter plus archive retention on publish; notifyHeld on a hold)";
  const position = opts.keepPosition
    ? `position: KEPT (--keep-position: published_at stays ${
        opts.publishedAt ? opts.publishedAt.toISOString() : "?"
      }, display_rank ${opts.displayRank ?? "none"} is restored; updated_at still moves, so the sitemap lastmod advances)`
    : "position: WILL move (fresh published_at, and the hold clears display_rank, so the card re-enters at the head of the unranked tail)";
  const slug = opts.slugChanges
    ? "slug: a NEW slug will be minted from the new title; old /work#slug fragments in past emails degrade to top-of-page"
    : opts.slug
      ? `slug: WILL NOT change (an unchanged title re-derives "${opts.slug}"); old links keep working`
      : "slug: none yet; this publish mints one";
  return `plan: ${emails} | ${position} | ${slug}`;
}
