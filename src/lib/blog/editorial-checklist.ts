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
// gives every source a "Cite as:" line — an outlet name, a normalized
// "Month D, YYYY" date, and the exact URL the checklist requires.
//
// Mirror of the archived reviews: this file IS the canonical checklist; keep
// ARCHITECTURE.md §5.11 in sync when items change.

export const NEWS_ARTICLE_CHECKLIST = `
PRE-PUBLISH CHECKLIST (every item is pass/fail; the article must pass all):
1. SOURCES: facts are attributed to at least 2 distinct named outlets or
   organizations (3 when the fact sheet allows); no single outlet carries
   more than half of the load-bearing claims when others are available.
2. PRIMARY FIRST: when the fact sheet contains the underlying report, order,
   filing, or the outlet that originated the story, cite that; aggregators
   are introduced with "reported" or "said", never asserted as my own voice.
3. LINK EVERY SOURCE: at each source's first mention, the source's name is
   the hyperlink anchor and the href is copied verbatim from that source's
   "Cite as:" URL in the fact sheet, like: [CSO](https://example.com/story)
   reported on July 14, 2026, that ... . The article must contain at least
   as many distinct external links as distinct named sources.
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
8. HEADLINE: composed fresh, never copied from a search-result title;
   at most 70 characters; contains a named actor and an active verb; proper
   nouns capitalized; no "you", no imperatives, no urgency words.
9. LEDE AND TL;DR: the first body sentence names who did or said what, with
   a reporting verb and a date. The TL;DR opens with that news, never with
   "Yes" or "No".
10. HEADINGS: short declarative statements; zero question headings.
11. QUOTES: quotation marks appear only around words a named person or
    organization actually said or wrote, verbatim from the fact sheet,
    attributed in the same sentence, with the speaker's title or affiliation
    at first mention. Standalone quotable-claim lines are my own words and
    carry no quotation marks.
12. STATISTICS: at least 2 named stats; numerals in house style (71%, not
    "seventy-one percent"); the value and unit verbatim from the fact sheet
    with formatting normalized; each stat carries its named source and date
    in the same sentence and says what population it describes.
13. ATTRIBUTION GRAMMAR: active voice with the named source as subject
    ("Axios reported"); never "it was reported", "experts say", "one
    source", "another source", or "the reporting" as a subject.
14. OPINION FENCE: first person appears only inside the single closing
    section titled "Tron's take", which is at most a quarter of the article;
    the body before it contains no advice aimed at the reader.
15. CONFLICT DISCLOSURE: if Tron's take recommends work in a category
    XL.net sells (managed IT, security assessments, incident response), the
    take contains one plain sentence saying XL.net sells it, and the
    recommendation ties to a specific fact in the day's story.
16. UPDATES: when this article replaces an already-published version, the
    text includes a short dated editor's note saying what changed and why;
    retired articles get a tombstone note, never a 404.
`.trim();
