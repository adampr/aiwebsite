// Redaction policy for uploaded work material (§5.16). Owner directive
// 2026-08-29: "if someone submits a zip and it contains personal info or
// credentials, instead of erroring out just clean it before you save it."
//
// ONE function does both jobs. sanitizeText() returns the cleaned text AND the
// hit inventory, and textLooksSecret() is DERIVED from it. A pattern that
// detects but fails to redact is impossible here by construction, because the
// only code that records a hit is the code that has just written a placeholder
// over it. That property is the reason this module replaced the old
// secret-patterns.ts, whose textLooksSecret() answered a question no caller
// could act on: it said THAT a file carried a credential and never WHERE, so
// the only available response was to refuse the whole upload.
//
// The bug that proves the point, found while writing this: the old private-key
// pattern matched `-----BEGIN ... PRIVATE KEY-----` and nothing after it. As a
// detector that was fine. As a redactor it would have deleted the header and
// left the base64 key body sitting in the corpus, and the corpus is what goes
// to the model and into Postgres. A boolean detector cannot be safely reused
// as a cleaner; the span is the whole point.
//
// Pure module, ZERO imports (the blocked-types.ts precedent). Every rule is
// string in, string out, so scripts/work-tests.ts drives the real policy with
// no zip, no DB and no network.
//
// HITS CARRY OFFSETS AND RULE IDS, NEVER THE MATCHED VALUE. secret-patterns.ts
// stated "reported as PATHS ONLY, never the matched value" in prose; here the
// type enforces it, so no disclosure surface, log line or ledger row can echo
// a credential even by accident.
//
// WHAT IS NOT REDACTED, AND WHY (the ruling this round turns on):
// ordinary work email addresses, phone numbers, person names and client
// company names are LEFT ALONE. This corpus is XL.net's own internal tooling
// documentation, where the address IS the subject matter ("the script mails
// flester@xl.net when the export fails"), and the panel writes the published
// card from exactly this redacted text. Measured before ruling: naive
// email+phone patterns fire 75 times on 1 MB of this repo's own technical
// documentation, every one of them a legitimate fact, while government-ID,
// payment-card and street-address patterns fire zero times. Redacting contact
// details would quietly turn working documents into nonsense and publish cards
// that are wrong about tools that work. The publication boundary is already
// held one layer down: lint.ts refuses an email address or a phone number in
// every visible card field, so nothing reaches /work either way.
//
// So the boundary is: redact what is harmful on a single disclosure and has a
// shape a regex can claim with near-certainty (keys, tokens, private keys,
// government identifiers, payment instruments), and leave everything else. The
// asymmetry between a redacted SSN and an untouched work address is deliberate
// and is not a defect report.

export type RedactionClass = "credential" | "personal";

/** One hit. Deliberately carries no `value` field: see the header. */
export interface RedactionHit {
  ruleId: string;
  cls: RedactionClass;
  /** Offsets into the ORIGINAL text. */
  start: number;
  end: number;
}

export interface SanitizeResult {
  /** The cleaned text. Identical to the input when `changed` is false. */
  text: string;
  hits: RedactionHit[];
  /** Characters removed, not counting the placeholders written in their place. */
  redactedChars: number;
  changed: boolean;
  /** True when hit RECORDING stopped at MAX_RECORDED_HITS. Redaction itself is
   * never capped, so this never means "something was left in". */
  hitsTruncated: boolean;
  /** Set when the file must leave the corpus whole rather than be patched:
   * a private-key header with no terminator inside the block bound. */
  excludeFile?: "unterminated-private-key";
}

interface RedactionRule {
  /** kebab-case and DIGIT-FREE: it is also the placeholder label, and a digit
   * in it would let the token trip lint.ts's phone-number ban. */
  id: string;
  cls: RedactionClass;
  re: RegExp;
  /** Which group is the secret. 0 = the whole match. A non-zero group keeps
   * the label ("PASSWORD=", "postgres://…@host") so the sentence still says
   * what the step needs; only the value goes. */
  valueGroup: number;
  /** Cheap String.includes prefilter; null means always run. */
  needle: string | null;
  verify?: (value: string) => boolean;
  /** Skip values that are obviously documentation placeholders. Never set on
   * private-key or on a vendor-prefixed token: a long base64 body can contain
   * a placeholder-looking run by chance, and skipping a real key to spare a
   * fake one is the wrong direction. */
  docVeto?: boolean;
}

export const MAX_RECORDED_HITS = 2000;
/** How far a private-key END marker may sit from its BEGIN before the block
 * counts as unterminated. A bound is required: without one a stray header
 * makes every scan run to end of file. */
export const PRIVATE_KEY_MAX_SPAN = 20_000;
/** A non-doc corpus file more than this fraction placeholder is not evidence;
 * extract.ts drops it from the corpus (it stays in the manifest). */
export const GUT_RATIO = 0.3;

/** The exact placeholder written in a span's place. */
export function placeholderFor(ruleId: string): string {
  return `[redacted:${ruleId}]`;
}

/** Matches any placeholder this module writes. Exported for extract.ts's
 * proseLength (a redaction must not buy prose credit) and for the idempotence
 * test. */
export const REDACTION_TOKEN_RE = /\[redacted:[a-z-]+\]/g;

/** Values that are plainly documentation, not credentials.
 *
 * THE KEYWORD ALTERNATIVES ARE ANCHORED, and that is the whole correctness of
 * this list. An earlier version matched `.*(?:example|vault|insert|todo).*`,
 * i.e. the keyword ANYWHERE in the value, so a real password whose text began
 * with the word "Vault", or an API key whose text began with the word
 * "insert", was vetoed and silently KEPT while the submitter was told the
 * upload had been cleaned. A documentation placeholder IS the whole value; a
 * credential that happens to contain an English word is still a credential.
 * (The two shapes are pinned as fixtures in scripts/work-tests.ts, assembled
 * at runtime so this repo's own pre-commit secrets gate does not read them as
 * real values.) */
const DOC_PLACEHOLDER_RE =
  /^["']?(?:x{3,}|\.{3,}|-{3,}|_{3,}|\*{3,}|\$\{[^}]*\}|%[A-Za-z_]+%|<[^>]*>|\[[^\]]*\]|(?:your|my|the)[ _-][A-Za-z _-]{0,40}|(?:example|sample|placeholder|redacted|changeme|change[ _-]me|todo|fixme|dummy|test[ _-]?value|insert[ _-]?(?:value|here)?|replace[ _-]?(?:me|this)?)(?:[ _-]?(?:value|here|key|token|secret|password))?)["']?$/i;

function isDocPlaceholder(value: string): boolean {
  return DOC_PLACEHOLDER_RE.test(value.trim());
}

// ---------------------------------------------------------------------------
// Verifiers. Each is a single linear pass over a string capped at 34 chars.
// ---------------------------------------------------------------------------

function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Luhn alone passes one random number in ten, so the issuer prefix carries
 * most of the confidence here. */
const CARD_IIN_RE = /^(?:4|5[1-5]|2[2-7]|3[47]|6011|65|35)/;

function paymentCardOk(raw: string): boolean {
  const digits = raw.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (!CARD_IIN_RE.test(digits)) return false;
  return luhnOk(digits);
}

function abaRoutingOk(raw: string): boolean {
  if (!/^\d{9}$/.test(raw)) return false;
  const d = [...raw].map((c) => c.charCodeAt(0) - 48);
  const sum =
    3 * (d[0] + d[3] + d[6]) +
    7 * (d[1] + d[4] + d[7]) +
    1 * (d[2] + d[5] + d[8]);
  return sum % 10 === 0 && raw !== "000000000";
}

function ibanOk(raw: string): boolean {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const rotated = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rotated) {
    const code = ch.charCodeAt(0);
    const part =
      code >= 65 && code <= 90 ? String(code - 55) : code >= 48 && code <= 57 ? ch : null;
    if (part === null) return false;
    for (const digit of part) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------
// The rules.
//
// Backtracking: the class that explodes is a NESTED UNBOUNDED quantifier
// ((X+)+). No rule here has one. Two rules nest bounded quantifiers
// (payment-card, iban) and are named rather than hidden. The lazy gaps in the
// label-anchored rules are all bounded, which is what keeps them linear, and
// the private-key body bound is load-bearing: an unbounded lazy scan to end of
// file per BEGIN header is quadratic in the number of headers.
// ---------------------------------------------------------------------------

export const SANITIZE_RULES: readonly RedactionRule[] = [
  // ---- credentials: vendor-issued, prefix-anchored ----
  { id: "anthropic-key", cls: "credential", re: /sk-ant-[A-Za-z0-9_-]{10,}/g, valueGroup: 0, needle: "sk-ant-" },
  { id: "openai-key", cls: "credential", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g, valueGroup: 0, needle: "sk-proj-" },
  { id: "aws-access-key-id", cls: "credential", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, valueGroup: 0, needle: "IA" },
  // Widened from the old list, which had sk_live_ only and let every test key
  // through; the pre-commit hook already covered both.
  { id: "stripe-key", cls: "credential", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, valueGroup: 0, needle: "k_" },
  // Was ghp_ only; GitHub mints five prefixes.
  { id: "github-token", cls: "credential", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, valueGroup: 0, needle: "gh" },
  { id: "github-pat", cls: "credential", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, valueGroup: 0, needle: "github_pat_" },
  { id: "slack-token", cls: "credential", re: /\bxox[baprse]-[A-Za-z0-9-]{10,}/g, valueGroup: 0, needle: "xox" },
  {
    id: "slack-webhook",
    cls: "credential",
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,}/g,
    valueGroup: 0,
    needle: "hooks.slack.com",
  },
  { id: "google-api-key", cls: "credential", re: /\bAIza[0-9A-Za-z_-]{30,}/g, valueGroup: 0, needle: "AIza" },
  { id: "google-oauth-secret", cls: "credential", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g, valueGroup: 0, needle: "GOCSPX-" },
  { id: "resend-key", cls: "credential", re: /\bre_[A-Za-z0-9]{20,}\b/g, valueGroup: 0, needle: "re_" },
  {
    id: "sendgrid-key",
    cls: "credential",
    re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    valueGroup: 0,
    needle: "SG.",
  },
  // In the pre-commit hook and missing from the old module list.
  { id: "twilio-sid", cls: "credential", re: /\b(?:SK|AC)[a-f0-9]{32}\b/g, valueGroup: 0, needle: null },
  { id: "npm-token", cls: "credential", re: /\bnpm_[A-Za-z0-9]{30,}\b/g, valueGroup: 0, needle: "npm_" },
  {
    id: "azure-storage-key",
    cls: "credential",
    re: /\bAccountKey=([A-Za-z0-9+/=]{40,})/g,
    valueGroup: 1,
    needle: "AccountKey=",
  },
  {
    id: "json-web-token",
    cls: "credential",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    valueGroup: 0,
    needle: "eyJ",
  },
  // PRIVATE KEYS ARE NOT A RULE HERE. privateKeyEdits() below does that job
  // with offset arithmetic instead of a regex span, for two reasons, both
  // measured, both defects in the first cut:
  //
  // COST. The obvious pattern is BEGIN + a lazy [\s\S]{0,20000}? gap + END.
  // For a header with no terminator the engine expands that gap up to 20,000
  // times, once per header in the file, so a document of repeated BEGIN lines
  // is quadratic in disguise: 2 MB of them measured at 2.8s, a 38 KB upload of
  // eight such entries at 22s of BLOCKING CPU in the single Next fork, and
  // ~95s if a submitter fills the 64 MB inflate budget. That is a denial of
  // service any authorised submitter could trigger with a small attachment.
  //
  // CORRECTNESS. A regex rule redacts per MATCH, while "is there an
  // unterminated key here" is a question about every OCCURRENCE. One complete
  // BEGIN/END pair earlier in the file satisfied the old whole-text paired
  // test, so the guard never fired and a second, unterminated key's body rode
  // through verbatim into the corpus, the stored archive and the retention
  // mail, while the submitter was told the upload had been cleaned.
  // userinfo with a colon before the @ is a password by construction. The
  // scheme and host survive, so the sentence still says which database.
  {
    id: "connection-string-password",
    cls: "credential",
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|ftp|https?):\/\/([^\s/:@]{1,64}:[^\s/@]{1,64})@/g,
    valueGroup: 1,
    needle: "://",
  },
  // Label-anchored, so the label survives and the reader still learns the step
  // needs a password. Disjoint classes on both sides of the quote: no
  // backtracking.
  {
    id: "secret-assignment",
    cls: "credential",
    re: /\b(?:API[_-]?KEY|APIKEY|SECRET(?:[_-]?KEY)?|CLIENT[_-]?SECRET|PASSWORD|PASSWD|PWD|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|BEARER[_-]?TOKEN|PRIVATE[_-]?KEY)[A-Z0-9_-]{0,24}\s*[:=]\s*(["'][^"'\n]{8,200}["'])/gi,
    valueGroup: 1,
    needle: null,
    docVeto: true,
  },

  // ---- personal: harmful on one disclosure, shape a regex can claim ----
  // Hyphenated only. A bare nine-digit run is never matched.
  {
    id: "us-social-security-number",
    cls: "personal",
    re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    valueGroup: 0,
    needle: "-",
  },
  { id: "us-taxpayer-id", cls: "personal", re: /\b9\d{2}-[7-9]\d-\d{4}\b/g, valueGroup: 0, needle: "-" },
  {
    id: "payment-card",
    cls: "personal",
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    valueGroup: 0,
    needle: null,
    verify: paymentCardOk,
  },
  {
    id: "iban",
    cls: "personal",
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g,
    valueGroup: 0,
    needle: null,
    verify: ibanOk,
  },
  {
    id: "bank-routing-number",
    cls: "personal",
    re: /\b(?:routing|aba|rtn)(?:[ _-]?(?:number|no|nbr|#))?\b[^\n]{0,24}?\b(\d{9})\b/gi,
    valueGroup: 1,
    needle: null,
    verify: abaRoutingOk,
  },
  // Requires a BANKING context word before the word "account", so a PSA or
  // CRM "account number 4471203" survives untouched.
  {
    id: "bank-account-number",
    cls: "personal",
    re: /\b(?:bank|checking|savings|ach|wire|routing|aba)\b[^\n]{0,48}?\b(?:account|acct)(?:[ _-]?(?:number|no|nbr|#))?\b[^\n]{0,24}?\b(\d{6,17})\b/gi,
    valueGroup: 1,
    needle: null,
    docVeto: true,
  },
  {
    id: "date-of-birth",
    cls: "personal",
    re: /\b(?:date[ _-]of[ _-]birth|d\.o\.b\.?|dob|birth[ _-]?date)\b[^\n]{0,16}?((?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4})|(?:\d{4}-\d{2}-\d{2})|(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}\.? \d{1,2},? \d{4}))/gi,
    valueGroup: 1,
    needle: null,
    docVeto: true,
  },
  // The \b is what keeps this off "Passportal", the MSP credential manager.
  {
    id: "passport-number",
    cls: "personal",
    re: /\bpassport(?:[ _-]?(?:number|no|nbr|#))?\b[^\n]{0,16}?\b([A-Z]?\d{6,9})\b/gi,
    valueGroup: 1,
    // No needle: the rule is case-insensitive and a literal prefilter is not,
    // so "PASSPORT NUMBER ..." would be skipped by any casing we picked.
    needle: null,
    docVeto: true,
  },
  // Spelled out only: "DL" in MSP documentation is a distribution list.
  //
  // THE VALUE MUST CONTAIN A DIGIT, and that lookahead is not decoration. The
  // class is [A-Z0-9] but the rule is case-INSENSITIVE, so without it the
  // value group matches any ordinary 6-to-14-letter WORD sitting near the
  // label: measured against 1.3 MB of this repo's own prose, the only hit in
  // the whole corpus was this rule eating the word "Ordinary" out of a
  // sentence that merely mentioned driver licences. Real licence numbers carry
  // digits; English words near the phrase do not.
  {
    id: "drivers-license-number",
    cls: "personal",
    re: /\bdriver'?s?[ _-]?licen[sc]e(?:[ _-]?(?:number|no|nbr|#))?\b[^\n]{0,16}?\b((?=[A-Z0-9]*\d)[A-Z0-9]{6,14})\b/gi,
    valueGroup: 1,
    needle: null,
    docVeto: true,
  },
  // No `i` flag on purpose: the acronyms must be uppercase, so German "ein"
  // and an ordinary "tin" in prose cannot fire.
  {
    id: "employer-tax-id",
    cls: "personal",
    re: /\b(?:EIN|TIN|Tax[ _-]?ID(?:entification)?(?:[ _-]?Number)?)\b[^\n]{0,16}?\b(\d{2}-\d{7})\b/g,
    valueGroup: 1,
    needle: null,
    docVeto: true,
  },
];

/** Filenames refused wherever they appear in a zip: the file IS the secret, so
 * there is no content-minus-the-secret to keep. Never inflated, never decoded,
 * never in the corpus; since this round, dropped from the stored archive
 * instead of refusing the upload. Mirrors the pre-commit hook's staged-file
 * check; when you change one, change the other. */
export const SECRET_FILENAME_PATTERNS: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\..+/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^id_ecdsa/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /^credentials\.json$/i,
  /^service-account.*\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
];

export function fileNameLooksSecret(basename: string): boolean {
  return SECRET_FILENAME_PATTERNS.some((re) => re.test(basename));
}

/** The mask character. Provably safe rather than merely convenient:
 * extract.ts's decodeUtf8Text rejects any buffer containing a NUL, so corpus
 * text can never hold one, so masking cannot collide with real content; and
 * NUL sits outside every positive character class in every rule, so a masked
 * region terminates any match trying to run through it. */
const MASK_CHAR = "\u0000";

/** Length-preserving mask over already-written placeholders, so offsets in the
 * masked string are identical to the original's.
 *
 * THIS IS WHAT MAKES THE TRANSFORM IDEMPOTENT, and it is not theoretical: two
 * rules re-matched their own output before it existed. A written
 * `postgres://[redacted:connection-string-password]@host` re-matched
 * connection-string-password, because the token carries a colon and reads as
 * user:pass; and the token text `date-of-birth` is itself matched by the
 * date-of-birth label, after which the lazy gap reached forward and ate the
 * next real date on the line. Per-rule tuning would have fixed those two and
 * left the class open for every rule added later. */
function maskPlaceholders(text: string): string {
  return text.replace(REDACTION_TOKEN_RE, (m) => MASK_CHAR.repeat(m.length));
}

interface Edit {
  start: number;
  end: number;
  ruleId: string;
  cls: RedactionClass;
}

/** Every private-key block in `masked`, as spans, plus whether any header was
 * left unterminated. Linear: one global scan for headers, one bounded search
 * per header for its terminator. Never backtracks, and answers per OCCURRENCE,
 * so a paired block earlier in the file cannot vouch for an unpaired one
 * later. */
function privateKeyEdits(masked: string): {
  edits: Edit[];
  unterminated: boolean;
} {
  const BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
  const END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;
  const edits: Edit[] = [];
  let m: RegExpExecArray | null;
  while ((m = BEGIN.exec(masked)) !== null) {
    END.lastIndex = m.index + m[0].length;
    const e = END.exec(masked);
    if (e === null || e.index - m.index > PRIVATE_KEY_MAX_SPAN)
      return { edits: [], unterminated: true };
    const end = e.index + e[0].length;
    edits.push({ start: m.index, end, ruleId: "private-key", cls: "credential" });
    BEGIN.lastIndex = end;
  }
  return { edits, unterminated: false };
}

/**
 * THE function: clean the text and report what was removed.
 *
 * Deterministic, pure and idempotent. Determinism is a requirement, not a
 * nicety: mergeSkillCorpus dedupes corpus entries by exact text equality, so
 * two byte-identical files must redact to byte-identical output. No counters,
 * no per-hit numbering, no randomness; the placeholder carries the rule id and
 * nothing else.
 */
export function sanitizeText(text: string): SanitizeResult {
  const masked = maskPlaceholders(text);

  // Key material first, and per OCCURRENCE. An unterminated header cannot be
  // spanned, and leaving a key body in the corpus because an END marker was
  // missing is the one outcome this module exists to prevent, so that file
  // leaves whole rather than being patched around.
  const keys = privateKeyEdits(masked);
  if (keys.unterminated)
    return {
      text,
      hits: [],
      redactedChars: 0,
      changed: false,
      hitsTruncated: false,
      excludeFile: "unterminated-private-key",
    };

  const edits: Edit[] = [...keys.edits];
  for (const rule of SANITIZE_RULES) {
    if (rule.needle !== null && !masked.includes(rule.needle)) continue;
    // `d` so match.indices gives each group's true offset (see below).
    const re = new RegExp(rule.re.source, rule.re.flags.includes("d") ? rule.re.flags : rule.re.flags + "d");
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const value = rule.valueGroup === 0 ? m[0] : m[rule.valueGroup];
      if (value === undefined || value === "") continue;
      if (rule.verify && !rule.verify(value)) continue;
      if (rule.docVeto && isDocPlaceholder(value)) continue;
      // THE GROUP'S REAL OFFSET, from the `d` flag, never m[0].indexOf(value).
      // indexOf finds the FIRST occurrence of that text inside the match,
      // which is a different position whenever the value repeats: for
      // "bank account 123456 routing 123456" the label-anchored rules would
      // redact the earlier copy and leave the real one in the stored corpus,
      // while reporting the file cleaned.
      const groupAt = m.indices?.[rule.valueGroup]?.[0];
      const start = groupAt ?? m.index;
      edits.push({ start, end: start + value.length, ruleId: rule.id, cls: rule.cls });
    }
  }
  if (edits.length === 0)
    return { text, hits: [], redactedChars: 0, changed: false, hitsTruncated: false };

  // Leftmost-longest, deterministic: earliest start wins, and on a tie the
  // longer span wins so a nested match cannot split a larger secret.
  edits.sort((a, b) => a.start - b.start || b.end - a.end);

  const out: string[] = [];
  const hits: RedactionHit[] = [];
  let cursor = 0;
  let redactedChars = 0;
  let hitsTruncated = false;
  for (const edit of edits) {
    if (edit.start < cursor) continue; // overlapped by an earlier, longer span
    out.push(text.slice(cursor, edit.start));
    out.push(placeholderFor(edit.ruleId));
    redactedChars += edit.end - edit.start;
    // Recording is capped; REDACTION NEVER IS. Beyond the cap the loop keeps
    // replacing spans and stops pushing records, which bounds what a hostile
    // file can make us hold without ever weakening the cleaning. Do not invert.
    if (hits.length < MAX_RECORDED_HITS)
      hits.push({ ruleId: edit.ruleId, cls: edit.cls, start: edit.start, end: edit.end });
    else hitsTruncated = true;
    cursor = edit.end;
  }
  out.push(text.slice(cursor));
  return {
    text: out.join(""),
    hits,
    redactedChars,
    changed: true,
    hitsTruncated,
  };
}

/** Derived from the cleaner, so it can never disagree with it. */
export function textLooksSecret(text: string): boolean {
  const result = sanitizeText(text);
  return result.changed || result.excludeFile !== undefined;
}
