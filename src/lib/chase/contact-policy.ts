// Chase register: the blocked-contact guard (ARCHITECTURE.md §5.21).
//
// THE INCIDENT THIS FENCES OFF: a seeded task's detail text named a
// machine-account identity as a relaying contact ("(relayed by ...)"), and
// the weekday nudge then mailed that sentence to a colleague. The site must
// NEVER name those identities as contacts in outbound mail: they are not
// people a reader can write to, and pointing a cornered colleague at one is
// the same failure as a typo'd requester, dressed up as a person.
//
// THE IDENTITIES THEMSELVES ARE NOT IN THIS FILE, and are no longer named
// in this repository's tree: it is PUBLIC, and git history is exactly why
// this guard hashes rather than spells (a literal, once committed, outlives
// any revert; earlier history is the ambient risk the guard now fences the
// future against). So the guard stores sha256 digests of the LOWERCASED
// identity strings (two email addresses, two "first last" name bigrams),
// exactly the directory_suppressions pattern (§5.18 stores
// sha256(lower(email)) so a suppressed address is honored without being
// recorded). Detection hashes candidate substrings of the text being
// checked and compares digests; the raw identities are never spelled or
// matched by regex here. Honest limit, accepted: unsalted sha256 over
// low-entropy identities is dictionary-CONFIRMABLE by design (anyone who
// already guesses an identity can verify it against the set), the same
// tradeoff directory_suppressions made; the digests stop the repository
// from NAMING anyone, not a targeted guess.
//
// A SEPARATE MODULE, not config.ts, on purpose: config.ts is the chase
// lane's import-free pure layer and this needs node:crypto. Everything here
// is still PURE and DB-free, importable by the seed script, the compose
// path and the report builder alike, and every function takes the hash set
// as a parameter so scripts/chase-tests.ts can pin the behaviour with
// INVENTED identities hashed inside the test, never the production ones.
//
// Two fences, in order of strength:
//   1. chase-seed.ts REFUSES a batch whose rows name a blocked identity
//      (the real fence: a bad row never enters the register).
//   2. composeNudge and buildReportBody scrub at the interpolation edge
//      (the backstop, for a legacy row seeded before this guard existed).
//
// No em dashes or en dashes (site rule).

import { createHash } from "node:crypto";
import { clip } from "./config";

/** sha256(lowercase(identity)) for each identity the site must never name
 * as a contact. Two are email addresses, two are "first last" name
 * bigrams. The set is the whole policy: adding an identity is adding a
 * digest here, and nothing else changes. */
export const BLOCKED_CONTACT_SHA256: ReadonlySet<string> = new Set([
  "1f4d6c1147c36b8517149e963060fd37984900298c928e67c1392232b446a262",
  "7188613a94ce0f7c175abba8c089e992d582e94b526c84ec1e186b6d0990d0fc",
  "fd0cc391c07359188c8fe0ce42bb10c19ad2bec0f9cf4dc1f1594a2dd4606cdb",
  "52c06ffbdbd6fedf8db06b0bcafc28ab3ee27ce7ed004389ce7333513cb3ef68",
]);

function sha256Lower(s: string): string {
  return createHash("sha256").update(s.toLowerCase()).digest("hex");
}

/** One detected mention: character span into the checked text. */
export interface BlockedContactSpan {
  start: number;
  end: number;
  kind: "email" | "name";
}

// The two candidate shapes. The email pattern is the same shape the test
// suite's synthetic-address scrape uses; the word pattern admits the
// apostrophes, dots and hyphens real names carry ("O'Brien", "St. John").
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const WORD_RE = /[A-Za-z][A-Za-z'.-]*/g;

/** PURE. Every span of `text` whose lowercased form hashes into the set:
 * email-shaped tokens, and consecutive word bigrams joined as "w1 w2"
 * (the form the name digests were taken over). Parameterized on the hash
 * set so tests inject their own; defaults to the production policy. */
export function findBlockedContacts(
  text: string,
  hashes: ReadonlySet<string> = BLOCKED_CONTACT_SHA256
): BlockedContactSpan[] {
  const spans: BlockedContactSpan[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const at = m.index ?? 0;
    if (hashes.has(sha256Lower(m[0])))
      spans.push({ start: at, end: at + m[0].length, kind: "email" });
  }
  const words = [...text.matchAll(WORD_RE)];
  // A word's trailing dot/apostrophe/hyphen is usually sentence punctuation
  // the class above swallowed ("Robot Persona." at the end of a sentence),
  // so BOTH the raw bigram and the trailing-trimmed one are hashed; either
  // hit marks the raw span.
  const trim = (w: string) => w.replace(/['.-]+$/, "");
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i];
    const b = words[i + 1];
    const rawHit = hashes.has(sha256Lower(`${a[0]} ${b[0]}`));
    const trimHit =
      !rawHit && hashes.has(sha256Lower(`${trim(a[0])} ${trim(b[0])}`));
    if (rawHit || trimHit)
      spans.push({
        start: a.index ?? 0,
        // A trim-only hit leaves the sentence punctuation in place.
        end: (b.index ?? 0) + (rawHit ? b[0] : trim(b[0])).length,
        kind: "name",
      });
  }
  spans.sort((x, y) => x.start - y.start || y.end - x.end);
  return spans;
}

/** The enclosing relay parenthetical, when the span sits inside one:
 * "(relayed by X)", "(via X)", "(per X)". Those wrappers exist ONLY to
 * name the relaying identity, so replacing the identity and keeping the
 * shell would print "(relayed by someone@example.com)", which promotes the
 * replacement address to a claim nobody made. The whole parenthetical goes
 * instead. */
function enclosingRelayParenthetical(
  text: string,
  span: BlockedContactSpan
): { start: number; end: number } | null {
  const open = text.lastIndexOf("(", span.start);
  if (open === -1) return null;
  if (text.slice(open + 1, span.start).includes(")")) return null;
  const close = text.indexOf(")", span.end);
  if (close === -1) return null;
  if (text.slice(span.end, close).includes("(")) return null;
  const lead = text.slice(open + 1, span.start).trimStart().toLowerCase();
  if (!/^(relayed by\b|via\b|per\b)/.test(lead)) return null;
  return { start: open, end: close + 1 };
}

/** PURE, deterministic, and never a regex over the raw identity. Remove
 * every blocked mention from `text`: a mention inside a relay
 * parenthetical takes the whole parenthetical with it ("Adam (relayed by
 * X) has decided" becomes "Adam has decided"); a bare mention is replaced
 * by `replacementEmail`, which callers set to the row's requester, the one
 * human whose address every chase email already names as the contact.
 * Accepted limit: a relay phrase OUTSIDE a parenthetical ("relayed by X"
 * in running prose, or inside nesting this walker does not model) gets the
 * bare replacement, which promotes the replacement address to the relayer
 * role in that sentence. Wrong-ish but safe (it names a human who can
 * actually be written to), and the seed gate refuses new rows shaped like
 * that before they ever reach a compose. */
export function scrubBlockedContacts(
  text: string,
  replacementEmail: string,
  hashes: ReadonlySet<string> = BLOCKED_CONTACT_SHA256
): string {
  const spans = findBlockedContacts(text, hashes);
  if (spans.length === 0) return text;

  // One edit per span, widened to the parenthetical where there is one.
  // Overlapping edits collapse to the first (two blocked mentions inside
  // one parenthetical produce one deletion, not two); when a WIDENED edit
  // would overlap an earlier one, the bare span edit stands in for it, so
  // no detected mention is ever left in place by the collapse.
  const edits: { start: number; end: number; insert: string }[] = [];
  for (const span of spans) {
    const paren = enclosingRelayParenthetical(text, span);
    const bare = { start: span.start, end: span.end, insert: replacementEmail };
    const wide = paren ? { ...paren, insert: "" } : bare;
    const last = edits[edits.length - 1];
    if (!last || wide.start >= last.end) edits.push(wide);
    else if (bare.start >= last.end) edits.push(bare);
  }

  // Right to left, so earlier offsets stay valid.
  let out = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    out = out.slice(0, e.start) + e.insert + out.slice(e.end);
  }
  // Whitespace tidy for the deletions: a removed parenthetical leaves the
  // spaces that flanked it ("Adam  has", "decided ."). The tidy runs over
  // the WHOLE string, not just the edited spans, so a pre-existing double
  // space or space-before-punctuation elsewhere in this string is
  // collapsed too: accepted, because only strings that actually carried a
  // blocked mention get this far, and the collapse never changes words.
  // Newlines survive; only runs of spaces/tabs collapse.
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?)])/g, "$1")
    .replace(/[ \t]+$/gm, "");
}

/** PURE. The seed gate's verdict for one row: null when clean, else the
 * refusal message chase-seed.ts prints. The message deliberately does NOT
 * echo the matched identity (echoing it into a terminal, a log or a
 * pasted bug report is the naming this guard exists to stop); the row is
 * named by its title, scrubbed with a neutral marker in case the title
 * itself is what tripped. */
export function seedRowContactRefusal(
  row: {
    title: string;
    detail: string;
    assigneeEmail: string;
    assigneeName: string;
    requesterEmail: string;
    /** Optional-nullable trio so a test can state a row in five lines;
     * chase-seed.ts passes its whole parsed row, so every field the
     * reminders or the report could ever print is covered. */
    actionUrl?: string | null;
    blockedReason?: string | null;
    detectorArg?: string | null;
  },
  hashes: ReadonlySet<string> = BLOCKED_CONTACT_SHA256
): string | null {
  const fields = [
    row.title,
    row.detail,
    row.assigneeEmail,
    row.assigneeName,
    row.requesterEmail,
    row.actionUrl ?? "",
    row.blockedReason ?? "",
    row.detectorArg ?? "",
  ];
  if (!fields.some((f) => findBlockedContacts(f, hashes).length > 0))
    return null;
  const safeTitle = clip(
    scrubBlockedContacts(row.title, "[removed]", hashes),
    120
  );
  return (
    `the row titled "${safeTitle}" references a machine-account identity (gate 6). ` +
    `The site must never name those identities as contacts in outbound mail; ` +
    `make the human contact the requester and re-run.`
  );
}
