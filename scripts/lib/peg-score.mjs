// News-peg scorer for the blog topic steering (ARCHITECTURE.md blog section).
//
// Why: the nightly top story is picked from Tavily results by raw relevance
// score, and a peg-less survey/opinion headline that wins the slot bypasses
// the strategist entirely — it becomes the calendar entry verbatim. Those
// stories are exactly the ones that fail the news-first rubric on
// voiceAdherence (2026-07-22: "Survey of business and tech leaders reveals
// persistent gap…" published noindexed with a WARN). This scorer DEMOTES
// peg-less signatures and BOOSTS dated-event signatures so a pegged story
// wins whenever one exists. Demotion, never exclusion: on a thin news day a
// survey story still leads (news.ts then injects report-of-record framing).
// 2026-07-30: also demotes vendor press releases (wire-distributor URL and/or
// PR-speak headline shape) — self-announcements are peg-perfect by
// construction (named actor + "Announces" + fresh) and one won the night,
// then failed the rubric on readability and voiceAdherence.
//
// Pure ESM, no imports — imported by scripts/fetch-ai-news.mjs (Node) and
// unit-tested by scripts/peg-score-tests.mjs without running any fetch.

/** Dated-event verbs — a named actor DID something reportable. "reveals"/
 *  "finds"/"suggests" are deliberately absent: those are study-reporting
 *  verbs, not event verbs. */
const EVENT_VERBS =
  /\b(?:launch(?:es|ed)?|releas(?:es|ed)|announc(?:es|ed)|unveil(?:s|ed)?|acquir(?:es|ed)|sue(?:s|d)|fine(?:s|d)|ban(?:s|ned)|sign(?:s|ed)|approv(?:es|ed)|rul(?:es|ed)|order(?:s|ed)|block(?:s|ed)|pass(?:es|ed)|file(?:s|d)|warn(?:s|ed)|publish(?:es|ed)|ship(?:s|ped)|report(?:s|ed)|said|says|deploy(?:s|ed)|rais(?:es|ed)|invest(?:s|ed)|breach(?:es|ed)|hack(?:s|ed)|patch(?:es|ed)|open-?sourc(?:es|ed))\b/i;

/** Known orgs/regulators — the actor half of actor+verb. Lowercase match. */
const KNOWN_ACTORS =
  /\b(?:openai|anthropic|google|deepmind|microsoft|meta|nvidia|xai|amazon|aws|apple|ibm|intel|amd|tesla|mistral|hugging\s?face|perplexity|salesforce|oracle|samsung|tsmc|stability\s?ai|cohere|databricks|palantir|eu|european\s(?:union|commission)|ftc|sec|doj|fcc|fda|nist|cisa|white\shouse|congress|senate|pentagon|supreme\scourt|uk|ofcom|un(?:esco)?|gallup|gartner|forrester|mckinsey|pew|deloitte|pwc|kpmg|accenture)\b/i;

/** Mid-title capitalized tokens that are NOT actors. */
const CAP_STOPLIST = new Set([
  "ai", "a.i.", "i", "it", "us", "usa", "gpt", "llm", "llms", "the", "a", "an",
  "and", "or", "but", "of", "in", "on", "for", "to", "with", "vs", "new",
  "why", "what", "how", "when", "who", "your", "this", "these",
]);

/** Peg-less signatures, each -2. */
const PEGLESS_PATTERNS = [
  { name: "survey", re: /\bsurveys?\b/i },
  { name: "poll", re: /\bpolls?\b/i },
  { name: "study-verb", re: /\b(?:report|study|research|index|analysis)\b[^.:]{0,60}?\b(?:finds|reveals|shows|suggests|warns)\b/i },
  { name: "pct-of-people", re: /\d+\s?%\s+of\s+(?:leaders|executives|workers|employees|companies|businesses|organizations|ceos|cios|americans|adults)/i },
  { name: "explainer-lead", re: /^(?:why|what|how)\b/i },
  { name: "opinion", re: /\b(?:opinion|commentary|op-ed)\b/i },
  { name: "question-title", re: /\?\s*$/ },
  { name: "state-of", re: /\bthe\sstate\sof\b/i },
];

/** Release verbs that make a fresh named survey its own valid peg. */
const RELEASE_VERBS = /\b(?:publish(?:es|ed)?|releas(?:es|ed)|announc(?:es|ed)|launch(?:es|ed)?)\b/i;

/** Paid press-release distribution domains. A wire hosts no journalism, so
 *  anything on one is a self-announcement by construction, and PR headlines
 *  are peg-perfect by construction (named actor + event verb + fresh):
 *  2026-07-30 a PR Newswire vendor announcement won the night at peg 5 and
 *  failed the rubric (readability 2, voiceAdherence 2). Demote, never
 *  exclude: on a thin news day a wire release may still lead. */
const WIRE_DOMAINS = [
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "accesswire.com",
  "prweb.com",
  "einpresswire.com",
  "newsfilecorp.com",
  "openpr.com",
];

/** Announcement-family verbs that open press-release headlines. Alone they
 *  are ordinary news verbs — the -pr-speak signal also needs two markers. */
const PR_VERB =
  /\b(?:announc(?:es|ed|ing)?|unveil(?:s|ed|ing)?|launch(?:es|ed|ing)?|introduc(?:es|ed|ing)|partner(?:s|ed|ing)?|releas(?:es|ed|ing)?)\b/i;

/** Marketing-copy markers that journalism headlines do not use. Each list
 *  entry counts at most once; -pr-speak needs PR_VERB plus >=2 of these.
 *  Catches the same press release syndicated on a non-wire domain (the
 *  2026-07-30 release also ran verbatim on finance.yahoo.com). */
const PR_MARKERS = [
  /\bstrategic\s+(?:partnership|collaboration|alliance)\b/i,
  /\bto\s+(?:deliver|empower|enable|transform|revolutioniz|accelerate|unlock|streamline)/i,
  /\b(?:end-to-end|next-gen(?:eration)?|industry-leading|best-in-class|cutting-edge|state-of-the-art|award-winning|world-class|first-of-its-kind|ai-powered|seamless(?:ly)?)\b/i,
  /\b(?:LLC|Inc\.?|Ltd\.?|Corp\.?|GmbH)\b/,
  /\bis\s+(?:proud|pleased|excited|thrilled)\s+to\b/i,
];

/** True when the item's URL is hosted on a wire domain (any subdomain). */
function isWireHost(url) {
  if (!url) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return WIRE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

const FRESH_MS = 48 * 3_600_000;

/**
 * True when the title names an actor: a known org/regulator, or a mid-title
 * Capitalized token (sentence-initial word excluded — "Survey of business…"
 * must not read as an actor) that is not on the stoplist.
 */
export function hasNamedActor(title) {
  if (KNOWN_ACTORS.test(title)) return true;
  const tokens = title.split(/\s+/);
  return tokens.slice(1).some((raw) => {
    const t = raw.replace(/[^A-Za-z.'-]/g, "");
    if (t.length < 2 || !/^[A-Z]/.test(t)) return false;
    return !CAP_STOPLIST.has(t.toLowerCase());
  });
}

/**
 * Score one headline's news-peg strength. Higher = harder peg.
 * `publishedAt` (ISO/RFC date string) and `now` (ms) feed the freshness
 * signal; `url` feeds the wire-domain demotion; all optional. Returns
 * { score, signals } — signals are the matched rule names, for the stderr
 * audit log.
 */
export function pegScore(title, { publishedAt, now = Date.now(), url } = {}) {
  const signals = [];
  let score = 0;

  const actor = hasNamedActor(title);
  if (actor) {
    score += 2;
    signals.push("+actor");
  }
  if (EVENT_VERBS.test(title)) {
    score += 2;
    signals.push("+event-verb");
  }
  if (/(?:\$\s?[\d,.]+|\d+(?:\.\d+)?\s?%|\b\d{2,}\b)/.test(title)) {
    score += 1;
    signals.push("+number");
  }
  let fresh = false;
  if (publishedAt) {
    const t = Date.parse(publishedAt);
    if (Number.isFinite(t) && now - t <= FRESH_MS) {
      fresh = true;
      score += 1;
      signals.push("+fresh");
    }
  }

  let pegless = false;
  for (const { name, re } of PEGLESS_PATTERNS) {
    if (re.test(title)) {
      pegless = true;
      score -= 2;
      signals.push(`-${name}`);
    }
  }

  // A fresh named survey IS a valid peg: the release itself is the dated
  // event ("Gallup publishes 2026 AI adoption survey"). Offset once.
  if (pegless && actor && (RELEASE_VERBS.test(title) || fresh)) {
    score += 2;
    signals.push("+named-release-offset");
  }

  // Press-release demotion (2026-07-30): a self-announcement's headline
  // signals are indistinguishable from hard news, so the URL and the
  // marketing-copy shape carry the demotion. Deliberately placed AFTER the
  // named-release offset and excluded from it: every press release is a
  // fresh named announcement, so the offset would undo this exactly.
  if (isWireHost(url)) {
    score -= 4;
    signals.push("-wire");
  }
  if (PR_VERB.test(title) && PR_MARKERS.filter((re) => re.test(title)).length >= 2) {
    score -= 3;
    signals.push("-pr-speak");
  }

  return { score, signals };
}

/**
 * Re-rank Tavily results by (pegScore desc, tavily score desc) — a stable
 * demotion sort, never a filter. Each item needs { title, score } and may
 * carry { published_date, url }. Returns new array of items decorated with
 * `pegScore`/`pegSignals`.
 */
export function rankByPeg(results, now = Date.now()) {
  return results
    .map((r) => {
      const { score, signals } = pegScore(r.title, {
        publishedAt: r.published_date,
        now,
        url: r.url,
      });
      return { ...r, pegScore: score, pegSignals: signals };
    })
    .sort((a, b) => b.pegScore - a.pegScore || (b.score ?? 0) - (a.score ?? 0));
}
