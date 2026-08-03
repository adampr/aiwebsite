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

/** Rolling time-window phrases ("Last 24 Hours", "Past 7 Days"). The digits
 *  describe a page's refresh window, not a reported fact: 2026-08-03 the
 *  "+number" signal fired on the "24" in "AI & LLM Releases Last 24 Hours"
 *  and helped an aggregator index page out-peg a real story. Used (global)
 *  only to strip the phrase from the number-signal haystack — never .test()
 *  a global regex, lastIndex is stateful. */
const TIME_WINDOW_G =
  /\b(?:last|past|previous|next|coming|rolling|trailing)\s+\d{1,3}\s+(?:hours?|days?|weeks?|months?|years?)\b/gi;

/** Roundup/digest/listicle title signatures (2026-08-03): a rolling
 *  aggregator page ("New Models Today — AI & LLM Releases Last 24 Hours",
 *  pricepertoken.com/news/model-releases) is peg-perfect by construction
 *  (named actor + "Releases" + fresh) and won the night, then failed the
 *  rubric (sum 19) as a keyword-driven roundup. Any one signature marks the
 *  title as an index of stories rather than a story. Deliberately absent:
 *  "report" (CrowdStrike report: ... is journalism), "today" (real headlines
 *  end in "Fines Start Today"), and bare leading numbers ("3 states sue ..."
 *  is hard news — the listicle shapes below need the listicle noun/superlative). */
const ROUNDUP_PATTERNS = [
  // digest nouns, in compilation-label position ONLY (title-terminal or
  // before a separator): "AI and Quantum Computing Briefing", "Morning AI
  // Briefing: ...". A mid-sentence digest noun is product or agency news
  // ("Google adds AI email digests to Gmail", "CISA bulletin warns of
  // AI-generated phishing surge", "Apple's AI recap feature misquotes BBC
  // headlines") and must not be demoted.
  /\b(?:round-?ups?|recaps?|digests?|briefings?|bulletins?|newsletters?)(?=\s*(?:$|[:|—–-]))/i,
  // week-in-review family: "Week In Review", "Week Ending August 1", "Week 31"
  /\bweek\s+(?:in\s+review|ending|\d{1,2}\b)/i,
  // anchored: "EU AI Act enforcement begins this week in all member states"
  // is hard news; only a title that OPENS "This Week in ..." is a digest
  /^this\s+week\s+in\b/i,
  // rolling window WITHOUT the definite article: aggregators label bare
  // windows ("Last 24 Hours", "Past 7 Days"); journalism writes "down for
  // the past 12 hours" / "exploited in the last 48 hours" (hours/days only —
  // months/years appear in real reporting: "over the past 12 months")
  /(?<!\bthe\s)\b(?:last|past|rolling|trailing)\s+\d{1,3}\s+(?:hours?|days?)\b/i,
  // listicle lead: "Top 10 ...", "10 Most Powerful ... Companies"
  /^(?:the\s+)?top\s+\d{1,3}\b/i,
  /^(?:the\s+)?\d{1,3}\s+(?:most|best|essential|key|great(?:est)?|leading|powerful|hottest|biggest|smartest|fastest|things|ways|tips|tools|trends|lessons|takeaways|reasons|signs|predictions|questions|examples|stats)\b/i,
];

/** Path segments that name a site section, not an article. */
const SECTION_WORDS = new Set([
  "news", "blog", "category", "categories", "tag", "tags",
  "topic", "topics", "section", "sections", "updates",
]);

/**
 * True when the URL looks like a section-index page rather than an article:
 * a 1-2 segment path opening with a section word whose final segment is a
 * short dateless label ("/news/model-releases", "/news"). Article slugs are
 * long and usually carry digits (date or story id), so
 * "/news/alloyed-announces-strategic-partnership-110000123.html" and
 * "/2026/07/29/slug" never match. Kept deliberately narrow (<=2 hyphen
 * tokens, lowercase letters/hyphens only) — a false positive here demotes a
 * real article by 2.
 */
function isSectionIndexUrl(url) {
  if (!url) return false;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const segments = pathname.toLowerCase().split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > 2) return false;
  if (!SECTION_WORDS.has(segments[0])) return false;
  const last = segments[segments.length - 1];
  return /^[a-z][a-z-]*$/.test(last) && last.split("-").length <= 2;
}

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
  // Time-window digits ("Last 24 Hours") are page-refresh metadata, not
  // reporting specificity — strip the phrase before looking for a number.
  // Real numbers elsewhere in the title ("Q2 2026", "$3.5B") still count.
  const numberHaystack = title.replace(TIME_WINDOW_G, " ");
  if (/(?:\$\s?[\d,.]+|\d+(?:\.\d+)?\s?%|\b\d{2,}\b)/.test(numberHaystack)) {
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

  // Roundup/digest/listicle demotion (2026-08-03): an aggregator index page
  // is a fresh named "Releases" headline by construction, so — same trap as
  // -wire — the named-release offset would undo this exactly. Deliberately
  // placed AFTER that offset and excluded from it. Fires once regardless of
  // how many signatures match (an index page matches several). Demotion,
  // never exclusion: on a thin news day a roundup may still lead (typically
  // landing at 0/+1 — news.ts report-of-record framing needs a negative total).
  if (ROUNDUP_PATTERNS.some((re) => re.test(title))) {
    score -= 3;
    signals.push("-roundup");
  }
  // URL half of the same demotion: a dateless section-index path hosts a
  // rolling page, not an article. Smaller magnitude than -wire because this
  // is shape inference, not a known-bad host list.
  if (isSectionIndexUrl(url)) {
    score -= 2;
    signals.push("-index-url");
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
