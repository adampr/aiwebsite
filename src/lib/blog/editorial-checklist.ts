// The news-article template checklist (adopted 2026-07-14).
//
// Distilled from two external-standards reviews (a wire-service standards
// editor and a media critic) of the full pipeline and archive. Both reviews
// found the same root failure: rules that live only in prose get skipped, so
// every item here is binary and phrased so the writer LLM can execute it and
// the rubric judge can verify it. The list is appended to
// blog.editorial.styleGuide in site.config.ts, which puts it in BOTH the
// writer prompt and the rubric's voiceAdherence scoring (module prompts.ts).
//
// The fact sheet referenced below is built by src/lib/blog/news.ts, which
// gives every source a "Cite as:" line: the outlet's display name (a
// hostname-to-name map in news.ts, title-cased base-domain fallback), a
// normalized "Month D, YYYY" date, and the exact URL the checklist requires.
//
// Mirror of the archived reviews: this file IS the canonical checklist; keep
// ARCHITECTURE.md §5.11 in sync when items change.
//
// 2026-07-25 amendments (items 2, 3, 9, 11, 12, 13), from the noindexed
// voiceAdherence=2 "harder to control" article: the module's per-section
// quotable-claim mandate plus item 11's old "my own words" wording produced
// a naked unattributed restatement line in every section; item 12's
// population clause produced separate "the figure refers to" explainer
// sentences; load-bearing facts repeated 3-4 times; outlets were named by
// bare domain (foxbusiness.com) because the fact sheet's "Cite as:" line
// carried a raw hostname (now mapped to a display name in news.ts); and
// attribution nested two verbs per sentence ("X reported that Y said").
// The styleGuide sentence that endorsed standalone quotable-claim lines
// was reworded in the same pass (site.config.ts). Each amendment below
// kills one of those devices; item 2 gains "according to" so item 13's
// cadence rule cannot collide with it.
//
// 2026-07-25 rankability amendment (item 8, owner directive): the nightly
// posts mirrored source outlets' headlines near-verbatim (07-24 post vs
// VentureBeat) and a zero-authority subdomain cannot win those SERPs. Item 8
// now bans any 4-consecutive-word overlap with brief/fact-sheet titles and
// requires the SMB stake in the headline, phrased fresh per story (a stock
// ending would just be a new template — both unrankable and dedup-hostile).
// The judge cannot see the brief, so the overlap ban is writer-side
// instruction; the stake/actor/verb/length clauses are judge-verifiable.
// Paired with the RANKABILITY_BRIEF in news.ts and the styleGuide title
// rule in site.config.ts.
//
// 2026-07-26 round 5 (solver+critic panel), from the third consecutive
// voiceAdherence=2 evaluation (07-25 nightly, 07-25 regenerate, 07-26
// nightly — the last two sum 23, failing on the min-3 rule alone): the
// checklist had become the trap. The preamble's "the article must pass all"
// rode into the rubric judge's scoring text via the styleGuide seam,
// instructing an unanchored judge that any detected miss = non-conformance
// = 2, a level a one-pass writer can never reach against ~60 binary
// clauses. This round: preamble reworded (drafting rule, not a reviewer
// mandate); a SCORING NOTE appended after item 16 giving the reviewer
// explicit 1-5 anchors for voiceAdherence (paired with the module's
// quality.rubric.calibration "anchored" knob, v1.29); item 13 rewritten to
// LICENSE varied attribution placement with a binary opener cap (the old
// source-as-subject mandate plus per-sentence attribution rules FORCED the
// every-sentence "X reported" cadence the judge then flagged as voice
// failure — a rule that fights itself); item 9 gains a TL;DR
// answer-vs-takeaway non-restatement clause (the 07-26 article triple-
// stated the core event); item 8 gains a colon-series-tag ban (the 07-26
// title padded with ": Security News Week", a franchise label).

export const NEWS_ARTICLE_CHECKLIST = `
PRE-PUBLISH CHECKLIST (each item is a pass/fail drafting rule; I draft and
revise until every item holds):
1. SOURCES: facts are attributed to at least 2 distinct named outlets or
   organizations (3 when the fact sheet allows); no single outlet carries
   more than half of the load-bearing claims when others are available.
2. PRIMARY FIRST: when the fact sheet contains the underlying report, order,
   filing, or the outlet that originated the story, cite that; aggregators
   are introduced with "reported", "said", or "according to", never
   asserted as my own voice.
3. LINK EVERY SOURCE: at each source's first mention, the outlet name from
   that source's "Cite as:" line in the fact sheet is the hyperlink anchor
   and the href is copied verbatim from the same line, like:
   [CSO](https://example.com/story) reported on July 14, 2026, that ... .
   Outlets are always written by that name (Fox Business, BBC, CBS News),
   never as a bare domain like foxbusiness.com. The article must contain
   at least as many distinct external links as distinct named sources.
4. NO INVENTED URLS: every external href in the article appears verbatim in
   the fact sheet. If a source has no URL there, name it without a link.
5. DATES: every cited source carries its date as "Month D, YYYY" at first
   mention. Never raw feed timestamps (no "GMT", no "Thu, 18 Jun"). Full
   attribution (outlet plus date) appears at first mention only; afterwards
   use the short form ("CSO said"); the same outlet-plus-date wording never
   appears more than twice in the article.
6. AGE FLAGS: any study, report, or incident more than a year old is
   introduced with its age ("a 2021 JAMA study", "a 2023 Samsung incident");
   nothing older than a week sits under "today", "what changed", or
   "the last 24 hours" framing unless its date is in the same sentence.
7. SINGLE-SOURCE CAUTION: a government order or ban, lawsuit, breach, or
   market-moving figure that rests on exactly one source is hedged in the
   text: "X reported ...; the report has not been confirmed elsewhere."
8. HEADLINE: composed fresh, never copied from a search-result title; shares
   no run of 4 or more consecutive words with the working title in my brief
   or with any source title in the fact sheet; at most 70 characters;
   contains a named actor, an active verb, and the stake for a small or
   mid-sized business reader; the stake wording is composed fresh for this
   story, never a stock ending like "what it means for SMBs"; never a
   colon-appended series tag or beat label (nothing shaped like
   ": Security News Week" or ": AI Roundup"; a colon followed by this
   story's own stake wording is allowed); proper
   nouns capitalized; no "you", no imperatives, no urgency words.
9. LEDE AND TL;DR: the first body sentence names who did or said what, with
   a reporting verb and a date. The TL;DR opens with that news, never with
   "Yes" or "No". The TL;DR states the news in fresh wording: no TL;DR
   sentence or takeaway shares its first 8 words with any body sentence,
   and the TL;DR uses only short-form attribution ("Fox Business
   reported"): the body lede owns the full outlet-plus-date first mention.
   Each takeaway states a fact the TL;DR's answer sentences do not; the
   answer and its takeaways never restate each other.
10. HEADINGS: short declarative statements; zero question headings in body
    sections. FAQ entries are exempt: their questions are the module's FAQ
    format, not headings under this rule.
11. QUOTES: quotation marks appear only around words a named person or
    organization actually said or wrote, verbatim from the fact sheet,
    attributed in the same sentence, with the speaker's title or affiliation
    at first mention. The quotable-claim sentence of each reporting section
    (every section before Tron's take) is one of
    that section's attributed reporting sentences (named source in the
    sentence, at most 25 words, no deictics, and, being my paraphrase, no
    quotation marks); it is never an extra unattributed sentence restating
    information the section already attributed. No sentence anywhere
    repeats the information of the sentence directly before or after it
    in different words.
12. STATISTICS: at least 2 named stats (when the fact sheet allows);
    numerals in house style (71%, not
    "seventy-one percent"); the value and unit verbatim from the fact sheet
    with formatting normalized; each stat carries its named source and date
    in the same sentence and says, inside that same sentence, what
    population it describes: never a separate sentence explaining what a
    number refers to. A statistic (any number other than a source's
    publication date) appears with its full value in at most one body
    section, and at most once within that section; the TL;DR and one FAQ
    answer may each carry it once more.
13. ATTRIBUTION GRAMMAR: every reported fact names its source within its
    own sentence in active voice, but the placement varies: source as
    subject ("Axios reported"), trailing (", Axios reported"), "according
    to Axios", or the story's own actor as subject with the outlet folded
    in ("OpenAI said it patched the flaw, TechCrunch reported"). In each
    body section, fewer than half of the sentences open with an outlet
    name or with "according to". Never "it was reported", "experts say",
    "one source", "another source", or "the reporting" as a subject.
    Never nest one attribution inside another ("X reported that Y said
    Z"); when an outlet relays a speaker, the speaker is the subject and
    the outlet trails. No two consecutive sentences open with the same
    source-plus-verb pattern.
14. OPINION FENCE: first person appears only inside the single closing
    section titled "Tron's take", which is at most a quarter of the article;
    the body before it contains no advice aimed at the reader.
15. CONFLICT DISCLOSURE: if Tron's take recommends work in a category
    XL.net sells (managed IT, security assessments, incident response), the
    take contains one plain sentence saying XL.net sells it, and the
    recommendation ties to a specific fact in the day's story.
16. UPDATES: when this article replaces an already-published version, the
    text includes a short dated editor's note saying what changed and why;
    retired articles get a tombstone note, never a 404. Any mention of the
    AI Desk's methodology or editorial standards is written as the markdown
    link [methodology](/methodology), never as a bare "/methodology" path
    or an unlinked plain-text reference.

SCORING NOTE (for the editorial reviewer; the writer drafts against every
item above): voiceAdherence measures whether the article IS what this guide
describes: a dated, source-attributed news report with all opinion fenced
in Tron's take. Calibration: 5 means the voice is exact and no checklist
deviation can be found. 4 means the voice is right throughout, with only
trivial mechanical slips. 3 (competent, the passing floor) means the voice
is right (dated attributed lede, inline sourcing, declarative headings,
opinion only in Tron's take, no self-quotes) with isolated checklist misses
a line edit would fix. 2 means the voice itself breaks somewhere: opinion
or advice outside the fence, load-bearing facts without attribution, op-ed
framing in the news body, quotation marks around unspoken words, or
violations so pervasive a line edit cannot fix them. 1 means the article is
not recognizable as this publication's news report. A clause that tests the
draft against the fact sheet or my brief (documents the reviewer does not
have) is out of scope for scoring; the reviewer never lowers a score by
guessing at it.
`.trim();
