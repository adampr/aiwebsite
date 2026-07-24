# ARCHITECTURE — ai.xl.net (XL.net AI site + Tron Netter)

> **Purpose of this document:** a complete, self-contained specification of this system,
> detailed enough to rebuild it from a clean room without reading the existing code.
> When code and this document disagree, the code wins — then fix this document.
>
> The brain engine (`packages/brain`) is a separate reusable repo with its own canonical
> architecture doc (`packages/brain/docs/Software_Brain_Canonical_Technical_Architecture_Master_v17.md`).
> This document specifies the brain only as far as this site consumes it (§7); rebuild the
> brain itself from its own doc.
>
> Likewise, the generic AI-company website machinery (`packages/aicompany`,
> **@aicompany/core**) is a separate reusable repo with its own canonical docs
> (`packages/aicompany/architecture.md`, README, MIGRATIONS.md). This document specifies
> only what this host configures and mounts (site.config.ts values, wrapper routes, the
> host-owned tables and scripts); rebuild the module from its own doc.

Last verified against code: 2026-07-24 (/work 18th exhibit `#sp-writer`, SP
Writer SweetProcess-documentation Claude Skill, metadata count seventeen →
eighteen; earlier same day: brain pin v1.107 `6440513` — vendor PG
adapter reconnect + brain-api /health DB deep-check; RCA of the 2026-07-24
chat outage on this host, same defect as roleplay's — see the pin section).
Previous: 2026-07-23 (/work exhibit row synced: seventeen exhibits
incl. `#ticketscribe`, `#ticket-summaries`, `#follow-up-emails`, `#beacon`,
`#morning-brief`; admin
governance review console: host-owned `/admin/governance` +
`src/lib/governance/admin-db.ts` + extraNav, §5.6/§5.12; no-ledger ruling
documented). Previously: 2026-07-22 (blog peg-aware topic steering + module
v1.10.0 escalation-ladder opt-in (`quality.maxRegenerates: 1`, styleGuide
report-of-record clause); workshop → Ticket Tailor; governance round 19c: adopt_outline
EMPTY-BUCKET TOLERANCE - a model reproducing the full sample skeleton emits
buckets for headings the draft has nothing to file under, and the old
whole-op shape rejection's one-line error made the repair model drop the op
(prod 2026-07-21: turn zero lost the skeleton adoption this way), so
validateTurn now DROPS empty buckets (host-enforced "skip headings that
would hold nothing", survivor order preserved, dropped headings surface only
via droppedOutlineTitles) while filed-but-mangled buckets (array under a
wrong key, non-kebab ids, missing title) still reject the WHOLE op with
errors that NAME the bucket (op index 0-based, bucket ordinal 1-based, title
slice as primary locator) so repair can fix rather than drop; applyOps
mirrors the emptiness guard at both store paths (an emptied bucket
disappears, never stores []); the adoption prompts state the drop
parenthetically; the usage_policy blueprint gains an eleventh section
`definitions` at position 2 (unfed - NOT-YET-DRAFTED is its route) so the
Definitions bucket has real content to hold on fresh projects. NOTE the
tolerance removes the empty-bucket TRIGGER but a turn-zero group invalid for
OTHER reasons (e.g. over-budget) can still lose its adopt op to a
repaired-ok output that dropped it - narrowed, not closed; the research
script logs "repair dropped the adopt_outline op" when that happens.
Existing projects keep their stored documents_json: no definitions section
appears in them unless a later turn drafts one organically, and until a
reformat re-adopts, such a section renders as a trailing top-level item
after the adopted buckets; ffiec watch: Feedly public-API mirror of
the CAPTCHA-blocked rss-whatsnew feed as the preferred change-signal leg;
governance round 19b: chain-level
list-vs-heading discrimination in `recoverLeadingNumberedHeadings` (round 19's
per-link list-parent skip broke the ascending chain on ISO-template samples
whose Definitions/Policy sections open with sub-lists, silently disarming the
whole outline machinery) plus the gated read-edge heal `healSampleHeadings`
for sample rows extracted under pre-fix code; round 20: FFIEC bank offering
+ bank-check switch + weekly FFIEC refresh; round 18e: bucket-title
PROVENANCE enforced - the live model invented 6 of 8 bucket titles under a
see-the-outline instruction, so applyOps now takes a bucketTitles allowlist
(sampleBucketTitles: top-level sample headings, numbering stripped): invented
titles reject the op whole, matching buckets are host-reworded to the sample's
wording and host-reordered to its sequence (same-title buckets merge), null
allowlist (no usable sample outline) rejects adoption outright, undefined =
legacy accept-any for unit shapes; both adoption prompts now spell the allowed
titles literally; round 19: PDF list
reading-order fix + list model v2 - `assemblePdfLines` reunites Word's
out-of-order auto-number labels (K=12 recency window, y-tolerance anchored
to a line's first member, x-splice with gap-based spaces, bullet-glyph
mapping, RTL/rotated fallback), `shapePdfListLines` adds marker-cluster
indent tiers + punctuation-gated continuation joins + residual orphan-label
drops, `recoverLeadingNumberedHeadings` keeps the heading chain alive on
reading-ordered output; the parser gains ordered `start` capture (split
lists keep their count), adjacent lettered runs as real letter lists, ONE
sub level, and a context-guarded `dropOrphanNumberLines` pre-parse pass
ordered BEFORE promotion; docx renders per-list two-level numbering with
`w:startOverride` (docx 9.7.1 copies levels[0].start, level 0 only,
positional) and upper/lowerLetter formats; the pane renders `<ol start>` +
inline `listStyleType`; `ORPHAN_DOT` strips heal stored ".7.1 Policy"
headings, see §5.12; previously round 18d: turn zero also
adopts the skeleton - the fresh-project-with-sample flow never enters a
reformat run, so buildTurnZeroUserMessage now carries the adopt_outline
instruction whenever the sample has a usable outline (flag from
governance-research.ts via sampleOutline); best-guess round 2:
deterministic repeated-label chips + expected chase emission + guess backfill
AI call; previously round 18c: alpha-marker
heading promotion — mirrored LETTER lines ("B. Data Handling") promote to
host-numbered headings under a consecutive-letter run guard, real lettered
heading sets shed their letters before host labels, see §5.12 rendering
contract; round 18b: template
skeleton adoption, "reparent never merge" - a whole-draft reformat with a
usable sample outline may emit ONE adopt_outline op per non-stub document: an
EXACT partition of ALL its section ids into ordered buckets titled from the
sample's top-level items (anything else rejected whole in applyOps; round 19c:
empty buckets are dropped by the host at validation, never a rejection); sections
stay the atomic content units (ids, confirm gates, feeds, markers untouched)
and the outline is a persisted PRESENTATION grouping inside documents_json (no
migration). planOutline (outline.ts) is the ONE render plan (doc pane + docx:
bucket headings top-level, sections nested "5.2" with three-level inner
numbers, single-section buckets fuse to the template's wording);
sectionDisplayLabel is the ONE label composer for every quoting surface
(test-gated: no direct sectionTitleText caller in quoting components).
Receipts report adoption with verified counts on every run ending incl.
stopped/shrunk, newly stored adoptions render only after the run ends
(groupedOkDocs hold), and a durable doc-pane note names up to two sample
headings dropped for lack of matching content. Companion fix: the PDF
extractor recovers section titles whose auto-numbers got glued to the line
END ("Purpose1.") via an ascending-chain guard into real "## 1. Purpose"
headings; the view exposes styleSample.outlineTitles (derived).
Previously: 2026-07-20 (governance round 18: AUP rename; round 17c: PDF letterhead
parity - owner ruling overriding the 17b panel's strip-only stance: repeated
PDF page-edge lines are now ADOPTED into downloads through the same shaping
pipeline as .docx parts (2-3 page docs require the line on EVERY page, 4+ keep
the 70 percent threshold, 1 page can never prove a frame), with a
false-positive guard: digits outside page-number patterns require EXACT
repetition and sentence-shaped page-citing lines are never candidates
(frameCandidateKey, both failure shapes e2e-proven then pinned), see §5.12
style-sample row; round 17b: sample letterhead +
verbosity adoption — a `.docx` format sample's page header/footer text is
captured at upload (`letterhead.ts`, migration 0016 `style_sample_header`/
`style_sample_footer`), rendered host-side into every generated .docx as real
Word page headers/footers (live PAGE/NUMPAGES fields, per-document title
substitution, per-page DRAFT marker and AI-provenance footer line; never in any
prompt), and the sample's measured words-per-section now states a SAMPLE LENGTH
target in drafting prompts (never restyle), see §5.12 style-sample and download
rows; also 2026-07-19: open-item best-guess
chips ride existing turns; previously round 16d: reformat hold
banner — while a restyle run locks the question area, the question card and
review panel lead with a live hold banner (pass count + why the lock + where
Stop/Skip lives) and the drafting question content recedes behind `.q-hold`,
see §5.12 restyle run; round 15g: chase-card Keep
as drafted — resolve-item now legal in drafting while a `qi_` chase question is
stored, fixing the verified "as is" dead loop, see §5.12 and the resolve-item
API row; round 16c: reveal tier
pipeline — sentence-bounded tier 2, region floor, cleared chips, reveal
channel v2, see §5.12; round 16: the idle "Reformat
the whole draft" button is DEBT-gated — since auto-reformat-on-upload (13d) it
was a standing no-op in the happy path; `style_sample_debt` (migration 0014)
holds an upload nonce meaning "the sample changed since the last COMPLETE
reformat run": set by the style-sample POST only when ≥1 drafted section could
mismatch (`uploadCreatesDebt`), cleared by sample DELETE and by the restyle
run's FINAL pass — the client marks the batch that empties its pending refs
(`restyleFinal`) and the worker clears the token inside the same fenced
`applyTurnWrite` (CASE on token equality: a replacement uploaded mid-run keeps
ITS debt; zombies write nothing). The view exposes `styleSample.reformatDebt`
(boolean, token never leaves the server); the control renders the button plus a
hedged status line only with debt, a zero-op validated restyle pass lands as a
no-change success (a wedged final pass would otherwise leave permanent false
debt), Stop during the final pass reports completion (debt cleared, button
gone), targets vanishing under a concurrent tab keep debt with honest copy, and
focus parks on the sample status line (or the Stop button on start-click) when
the gated block unmounts, see §5.12; round 18c: alpha-marker promotion — the
16b glue class closed for LETTER markers ("B. Data Handling" trailing the
previous sentence, owner report 2026-07-20): letters promote only inside
consecutive-letter same-separator runs whose members are separated by body
content, with initials-chain and enumeration guards; real "#" lettered
heading sets shed their letters before host labels (no "3.1 B. Data"
doubling) while a lone "## A. Smith Policy" keeps its name, see §5.12;
round 16b: manual-heading
promotion — bare sample-mirrored number lines ("3.1 Data handling") no longer
glue inline into the preceding paragraph; `promoteManualHeadingLines` runs
inside `parseMarkdown` so both renderers promote them to real host-numbered
headings, and the .docx gains an inner-heading spacing ladder + keepNext,
see §5.12 rendering contract; round 15f: cross-tab
resolution reveal — the answering tab broadcasts its diffed reveal items on a
per-project BroadcastChannel and a sibling tab watching the draft plays the
identical show at the exact same rev (owner report: answering in one window,
watching in another, saw no animation), see §5.12; round 15e: one Stop button —
the question/review pane's pause note no longer duplicates the sample control's
"Stop reformatting" (designer+critic panel; the duplicate read as a glitch and
had drifted); the note explains the lock and points at the control's button,
which is now RUN-gated, not name-gated, so a mid-run sample removal can never
leave an active run with no Stop anywhere, see §5.12; round 15d: real Word
numbering + PDF bookmarks in the format-sample extractor - word/numbering.xml
+ styles.xml parsed (docx-numbering.ts: linear scanners, clamped numerics,
lvl/pStyle back-references, permutation-safe counters) so auto-numbered
headings/lists surface as literal text; PDF getOutline() bookmark titles
upgrade matching extracted lines (number-stripped matching, slice-first
normalization, never synthesized); detectNumberingStyle heading votes now
authoritative over body votes; sample control shows the detected style,
announcements decouple numbering (render-derived, unstoppable) from the
stoppable reformat, removal announces the numbering reversion, and the
upload route logs a nothing-detected counter, see §5.12; round 15c: mid-run sample
fine print — Replace/Remove stay enabled during a restyle run (designer+critic
verdict: supersede, don't block); the control's standing helper swaps for one
run-state line that routes stop/skip intent to the dedicated Stop/Skip
controls, wired to both buttons via aria-describedby; removal receipts
distinguish queued-cancelled / stopping / stopped; the Stop button is no
longer disabled while "Stopping..." (focus-drop fix), see §5.12; same day
queued-reason copy: the workspace queued panel now names the actual park
cause — POST /research 202 `reason` kept client-side, kill switch
outranking, see §5.12 routes table;
round 15b: numbering-style
adoption — the host still owns all numbering but renders it in the sample's
detected style (decimal / decimal-zero / roman / alpha / paren / "Section N:"),
derived from the stored sample text at view/download time, never persisted,
see §5.12; round 15: promoted
"Your answers" block in the review panel — flat rows with always-visible
Change buttons replace the buried disclosure in review (quiet disclosure
stays for drafting/done), two-tool revise copy, legacy reopened-summary
prefix remap, idempotent withOpenItemsNote, see §5.12 Q&A history;
round 14c: review-phase open items
now ride the question-card structure — `open-items-resolver.tsx` rewritten
from a single-expansion accordion list to a one-item-at-a-time card
mirroring the drafting chase card, with a closed-by-default chip queue for
random access; staging/batching/keep economics unchanged, see §5.12; same
day round 13e: the reveal reaches everyone — reduced-motion plays a
simplified show through the same runner (the old early-return left
RDP/animations-off users with NOTHING, the owner's thrice-reported bug),
hidden-tab shows park and flush on return, breakpoint-flip flush,
queued-show line in the Questions pane, planShow extracted pure into
resolved-anim.ts, [gov-reveal]/[gov-stale] console diagnostics,
keepItem/applyTurn stale-offset invalidation (section-scoped for keeps),
and stale-bundle detection: the npm build script stamps
NEXT_PUBLIC_BUILD_ID=$(date +%s), view carries serverBuildId, a
dismissible reload banner via the pure staleBundleSignal rule, see
§5.12; same day: research hardening: profile-first mentions
anchor + `companyNameFromTitle`, post-redirect crawl dedupe, word-boundary brief
truncation, `research_audit_json` provenance envelope (migration 0013), presence-
semantics Tavily checkpoints; round 14b: structure
adoption — restyle turns retitle sections to the sample's terminology and
reorder them via the permutation-gated `reorder_sections` op; SAMPLE
OUTLINE digest of the whole stored sample rides every sample-carrying
prompt; PDF extraction infers headings from font height, see §5.12;
round 14: reopen a final
draft — `POST .../reopen` (done → review, rev-bumped + turn-cols cleared),
confirm ungated from the kill switch + per-project rate bucket, final-ZIP
README drops the review summary, "Back in review" panel variant, reopen
transcript rows; earlier same day round 13d: auto-reformat
on format-sample upload — the post-upload offer replaced by an automatic
whole-draft restyle run with queue/latched-Stop/watchdog/reload receipt,
see §5.12; round 13c: chase-phase
counter softeners — foreshadow chip suffix + one-time bridge line +
`isChaseId`, see §5.12; earlier round 13b: research
snapshot on background-check questions — blueprint `snapshot` flag on
UP-01/N-01 derived at VIEW time (retrofits stored Q1s), `companySnapshot`
on ProjectView, ask-anchor suppression for those questions; reveal
re-paced to ~30ms/char with a 15s budget trim, caret steady-while-typing
/ blink-through-hold, doc-pane parse-memo stabilization, see §5.12;
earlier same day round 12: non-advancing
turns — `questionId:"restyle"` format passes + `questionId:"amend"`
answer corrections through POST /answer, `resolveNonAdvancingGate`,
monotone question counter (`interview.ts`), transcript amend folding,
always-on `[TO CONFIRM]` marker highlighting + the resolution reveal
(`resolved-anim.ts`), reformat-the-draft control on the style sample, see
§5.12; earlier same day: async answer turn — POST /answer
returns 202 + in-process worker, `turn_*` claim columns w/ attempt-nonce
fence, poll-resolved client, Cloudflare-100s fix, migration 0012, see
§5.12/§6; same day: turn-zero robustness — no stubs at
turn zero, error logging, repair + op-level salvage — plus the §5.12
placeholder-honesty contract: `placeholderSections` on the view/turn
response, Planned rendering, confirm gate, docx notice, transcript
disclosure; same day: host-owned document numbering +
per-list docx numbering instances, §5.12 rendering contract; and:
workspace answer form: multi-select
suggestion chips + in-flight submit feedback, see §5.12; same day:
zero-marker finals — the confirm gate refuses while any `[TO CONFIRM]`
marker remains (lenient count), the review panel gains the open-items
resolver (keep-as-drafted via `POST .../resolve-item`, zero AI; typed
facts batched into one revise turn with `focusSections`), see §5.12;
same day: turn markdown budget split into stated target 12k / enforced
max 16k (the stated-equals-enforced 8k cap made heavy chase/revise turns
fail validation deterministically — the "hit a snag" incident), see
§5.12 turn contract; AI
Governance builder shipped —
new §5.12 /governance section, governance tables in §6, standards pipeline
in §8.1, `aiwebsite-governance` timer via the host post-install hook in
§9.7; standard-specific applicability probes added to the research
pipeline (§5.12, `src/lib/governance/probes.ts`) the same day. Brain submodule v1.97 @ e369242 —
dynamic multi-provider model routing, Issues #692–#696: registry
unification (anthropic claude-* ids now first-class routable alongside
openai/xai/google — `GET /v1/model-routing` rows can carry
`provider: "anthropic"`), router v2 behind the `BRAIN_ROUTER` env flag
(defaults to `legacy` — behavior-identical until flipped), runtime model
kill switch + routing telemetry (auto-migrations 45 — nullable
success/ttft_ms/total_ms/http_status/shadow_model columns on
usage_events — and 46 — `model_availability_overrides` table; both
additive, applied automatically on boot). Previous pin v1.96 @ 1b34555
(Issue #689 BRAIN_DB_TABLE_PREFIX fix). @aicompany/core v1.7.1
@ 71b7f6c — v1.7.1 privacy-page Your Data Rights section (§5.11/§5.13, renders on this host's module privacy page) + v1.7.0 caller-tools chat seam (unused here) + the v1.6.x fleet-convergence line (v1.6.2 export refuse seam, unused on this host):
the Troy approval tee is retired in favor of `channels.email.onInbound`
(site.config.ts; same envelope-recipient routing truth); §5.13
data-subject factories mounted at `GET /api/account/export` +
`POST /api/account/delete` (governance projects cascade; contact
submissions handled in extras/beforeDelete); deploy re-rendered with
`peer-monitor.sh` now template-stamped (§9.7) and
`scripts/git-hooks/pre-commit` template-rendered (secrets gate moved to
host-owned `pre-commit.local`); setup-vm pm2 reload carries
`--update-env` upstream (v1.6.1 — this host's HOST EDIT adopted, local
edit dropped). Previous pin v1.5.2 @ cfe2854 (strictly-better repair
adoption on the blog generate path). Previous pin v1.5.1 @ 78f3d55.
Next.js 16.2.9).

---

## 1. What this system is

A public marketing site for **XL.net's AI practice** at **https://ai.xl.net**, whose
centerpiece is **Tron Netter** — an AI agent persona reachable on four channels:

| Channel | Entry point | Handler |
|---|---|---|
| Web chat | Floating widget on every page | `POST /api/tron-netter/chat` → brain |
| SMS | Twilio number **+1 (872) 350-4325** | Twilio webhook → `POST /api/tron-netter/sms` → brain → Twilio REST |
| Email | Mailbox **Tron.Netter@ai.xl.net** (Resend inbound) | Svix webhook → `POST /api/webhooks/resend` → brain → Resend send |
| Voice | Same Twilio number, voice calls | Twilio → `https://ai.xl.net/brain/twilio/voice/*` → brain-api directly (site not involved) |

Tron Netter's knowledge is a nightly full crawl of `xl.net` + `ai.xl.net` (§8). The site also
has optional Google/Microsoft OAuth sign-in (§5.4) — additive; no page requires login to
render, but the AI Governance builder (§5.12) only functions for signed-in users
(`/governance` shows a sign-in pitch to visitors).
Signed-in users can additionally register a mobile number for SMS at `/texting` (§5.7):
consent checkbox + a texted 6-digit code that must be entered on the site before the number
is saved (TCPA-style verified opt-in; legal pages at `/privacy` and `/sms-terms`).

Everything runs on **one Azure VM** (`xladmin@52.237.160.75`, app dir `/var/www/aiwebsite`)
behind a **Cloudflare tunnel**. There is no load balancer, no container runtime, no cloud
managed DB — just PM2, nginx, Postgres, and cloudflared on a single box.

### Human-oversight invariants (do not remove when rebuilding)

- **Every outbound email is BCC'd to `adam@xl.net`** (`OUTBOUND_BCC_EMAIL`; enforced by
  @aicompany/core's email sender — a module §1 default-on invariant).
- **Tron Netter has no tools and no internet** on public channels: every brain call passes
  `disabledTools` = the brain's full tool list, and `memoryMode: "do_not_store"`.
- Public knowledge is limited to the two crawled sites; the persona prompt enforces this.

---

## 2. Runtime topology

```
                     Internet
                        │
              Cloudflare edge (TLS, DNS)
                        │  tunnel "aiwebsite" (ID 8dbfd62e-eb42-4589-8b76-d1edc77cd018)
                        ▼
                 cloudflared (systemd)  ──►  http://127.0.0.1:80
                        │
                 nginx (loopback-only :80, server_name ai.xl.net)
                   ├── /            ──► 127.0.0.1:3000  Next.js  (PM2 "aiwebsite")
                   ├── /_next/static──► 127.0.0.1:3000  (cached 365d immutable)
                   └── /brain/twilio/ ─► 127.0.0.1:3211/twilio/  (ONLY public brain surface;
                                          3600s timeouts for call WebSockets)
        ┌───────────────────────────────────────────────────────────────┐
        │  loopback-only services                                       │
        │   :3000  Next.js  (site + API routes)                         │
        │   :3211  brain-api      (PM2 "brain-api",  tsx, Express 5)    │
        │   :3213  skills-host    (PM2 "skills-host", tool sidecar)     │
        │   :5432  PostgreSQL     (db "aiwebsite", shared site+brain)   │
        └───────────────────────────────────────────────────────────────┘
```

- Next.js calls brain-api over loopback (`BRAIN_BASE_URL=http://127.0.0.1:3211`) with a
  Bearer key (first entry of `BRAIN_API_KEYS`). brain-api (v1.92+) is **fail-closed**: every
  endpoint except `/health` and `/twilio/*` requires the Bearer.
- skills-host is booted for completeness but effectively idle for the public persona
  (all tools disabled). The brain's `test-ui` app (:3212) is **not** run in production.
- Twilio webhooks are the only public brain traffic; the brain validates `X-Twilio-Signature`
  itself using `BRAIN_PUBLIC_URL` (**must be exactly** `https://ai.xl.net/brain` or Twilio gets 403s).

**Port map:** Next.js 3000 · brain-api 3211 · (test-ui 3212, dev only) · skills-host 3213 · Postgres 5432 · nginx 127.0.0.1:80.

---

## 3. Repository layout

```
aiwebsite/
├── site.config.ts              the whole host↔module interface (@aicompany/core §4):
│                               persona identity/prompt rules, channel copy, texting consent,
│                               memory voice, admin nav, oversight, privacy retention, crawl
│                               origins — every visitor-facing value ported VERBATIM from the
│                               legacy code (parity baseline, module MIGRATIONS.md)
├── instrumentation.ts          host-written register(): imports src/lib/db (table registry),
│                               then runs the module's runtimeCheck(siteConfig) (§4.3 layer 2)
├── src/                        Next.js 16 App Router source (§5)
│   ├── app/                    pages + thin wrapper routes over @aicompany/core (§5.1)
│   ├── components/             host-only components (email-link, futurism-fx,
│   │                           governance/ — the §5.12 workspace UI)
│   ├── lib/db/                 composed schema (module factories + host tables) + db wrapper
│   ├── lib/governance/         AI Governance builder (§5.12): blueprints, brain envelope,
│   │                           prompts, turn validation, research plumbing, docx/zip,
│   │                           shared render-time numbering (numbering.ts)
│   └── types/                  custom-element JSX typings
├── packages/brain/             git submodule ← https://github.com/adampr/xldev.git (§7)
├── packages/aicompany/         git submodule ← https://github.com/adampr/aicompany.git —
│                               @aicompany/core v1.4.0, installed as a file: dependency;
│                               channels, auth, admin, tracking, texting, memory, SEO,
│                               crawler, deploy templates (its own architecture.md is canonical)
├── data/                       VM-GENERATED knowledge files — gitignored from deploy --delete,
│   │                           rewritten nightly by the crawl (§8); never hand-edit
│   ├── tron-netter-knowledge.md        (~175 KB budgeted prompt doc, read at request time)
│   ├── tron-netter-knowledge-full.md   (~2.5 MB full crawl, audit only)
│   ├── aiwebsite-config.json           JSON config snapshot for the crawler (re-rendered at
│   │                                    deploy + by the knowledge timer's ExecStartPre)
│   ├── governance-standards/           quarterly-researched standards reference docs +
│   │                                    state.json (§8.1; written ONLY by the governance
│   │                                    timer script; survives deploys like all of data/)
│   └── GeoLite2-ASN.mmdb               MaxMind IP→ASN db (12 MB, gitignored; deploy.sh ships it
│                                        explicitly; shared copy with itsupportchicago) (§5.6)
├── scripts/                    ai-provider-health.mjs (§9.6); governance-research.ts +
│                               governance-standards-refresh.ts + governance-tests.ts (§5.12,
│                               §8.1; tsx, load .env via scripts/lib/governance-env.ts FIRST,
│                               top-level imports only); refresh-tron-knowledge.mjs is the
│                               LEGACY crawler — deploy now wires the module's crawler (§8)
├── deploy/                     site-deploy.env + files RENDERED from the module's
│                               deploy/templates (stamped; §9) + host extras (GO-LIVE.md,
│                               GOOGLE-OAUTH-SETUP.md, generated seed-persona-memories.sql,
│                               post-install.sh — the host hook that installs the
│                               aiwebsite-governance units, §9.7)
├── drizzle/migrations/         committed migration history (introspected baseline + diffs, §6)
├── drizzle.config.ts           schema ./src/lib/db/schema.ts → ./drizzle/migrations, dialect postgresql
├── public/                     favicons, brand assets, fx.js (<xl-dust> canvas particles)
├── eslint.config.mjs           ESLint 9 flat config: next/core-web-vitals + next/typescript;
│                               ignores packages/**, drizzle/**, data/** (submodules lint upstream)
├── next.config.ts              trailingSlash:false; experimental.inlineCss:true;
│                               transpilePackages:["@aicompany/core"];
│                               serverExternalPackages:["pdfjs-dist"] (pdf.js loads its
│                               worker via an import relative to pdf.mjs — bundling it
│                               into .next/server breaks every PDF extraction)
├── postcss.config.mjs          single plugin: @tailwindcss/postcss
└── tsconfig.json               strict, bundler resolution, alias @/* → ./src/*, excludes packages/brain
```

**Stack versions:** Node **22** (VM; brain requires ≥20) · Next.js **16.2.9** · React **19.2.4**
· TypeScript 5 · Tailwind **v4** · drizzle-orm 0.45 + `postgres` 3.4 driver · resend 6.17
· maxmind 5 + mmdb-lib (IP→org for /admin/companies).
`src/middleware.ts` is the module's tracking/CSRF middleware wrapper (§5.6). Module tooling via
`package.json` scripts: `config:check`, `doctor`, `simulate:sms`, `simulate:email`,
`upgrade:check`. `npm run lint` = `eslint .` (eslint 9 + eslint-config-next, flat config).
No test suite in the parent repo (the module and brain have their own).

---

## 4. Frontend

Twelve public pages, all served from the root layout (`src/app/layout.tsx`), plus the
admin console under `/admin/*` (§5.6):

| URL | Type | Content |
|---|---|---|
| `/` | static server component | Marketing home: hero with `<xl-dust>` particle canvas, theme-aware animated logo iframes (`/brand/xl-logo-animated-{dark,light}.html`), stat cards (79.8% issue reduction, 24/7, 99.3% CSAT), capability panels, CTA → `/contact` |
| `/work` | static server component | "Our Work" showcase: manifesto strip, then eighteen anchored product exhibits in narrative order (`#brain` Software Brain → `#aicompany` @aicompany/core → `#aiwebsite` this site, framed around the §1 oversight invariants → `#governance` AI Governance Writer, the §5.12 builder as a product exhibit (live · public, "Sign in to create" qualifier badge; three-facet sub-grid: Researched First / Nothing Silently Accepted / Yours, Then Gone; body anchor-links `#aiwebsite` + `#brain`; closing paragraph folds in the not-legal-advice hedge; internal `<Link>` `btn` CTA to `/governance` — the page's only internal-route exhibit CTA) → `#itsupportchicago` the autonomy experiment, explicitly "designed as a test of a 100% autonomous organization", sandbox facts first → `#qbr-machine` the Claude Code client-delivery pipeline (in production; three-deliverable sub-grid: Gap Analysis / Asset Strategy / QBR Deck; inline anchor link to `#lakehouse`) → `#onboarding-toolkit` the MSP-onboarding platform (in production; three-facet sub-grid: Discovery / Intake & Review / Runbooks) → `#lakehouse` XL Lakehouse, the scoped vault-backed access layer behind the AI teammates (in production; row-form "facet ledger" instead of the 3-col sub-grid; links back to `#qbr-machine`) → `#api-gateway` XL API Gateway, per-client-cloud API proxy (in development, console live — plain badge by rule: green `badge--ok` only when the panel's primary status is production as a whole; facet ledger; opener defines it against `#lakehouse` with an inline link) → `#roleplay` → `#leo-netter` internal Slack-bot test → `#spamslayer` SpamSlayer, an internal phishing-triage Slack bot (live · internal; standalone Python service on Claude Sonnet, not on the Brain; three-facet sub-grid: Four Checks / Never Clicks the Link / Errs Toward Caution; green `badge--ok` — production internally; the analysis rubric also ships as the `email-safety-check` Claude Skill) → `#ticketscribe` TicketScribe, a Claude Skill for chronological ticket notes + facts-only escalations (live · internal) → `#ticket-summaries` Autotask Ticket Summaries, a Claude Skill that reads open Autotask tickets via Chrome in the tech's own session, view-only, issue/done/next per ticket (live · internal) → `#follow-up-emails` Auto-Draft Follow-Up Emails, a Claude Skill for inside sales: pasted email/phone → PhoneBurner lookup → token-filled template draft in the rep's Gmail, no send step (live · internal) → `#beacon` Beacon, an internal Slack knowledge-layer assistant for #claude-teamhub: tool-registry dedup matching + SweetProcess governance citation via XL Lakehouse (MCP, read-only, no direct SweetProcess credential), code-gated permissions (restricted items redacted in channel, DM'd only after a live team-membership lookup), owner-reaction-gated registry writes with 72h expiry, weekly/on-demand manager digest; standalone Node.js + Slack Bolt Socket Mode + direct Anthropic API, not on the Brain (plain badge "Built · final setup" — built and module-tested against production data, Slack app not yet created) → `#morning-brief` Morning Brief, a Claude Skill that renders a personal morning glance as one drawn HTML page: a hand-sketched terrain line carrying the day's reading (light / normal / heavy) above two lists (needs-your-attention, already-resolved), reading only already-connected calendar/email/chat sources (a missing source thins the brief; no new access requested), invoked on demand via /morning or set up by the user as a recurring scheduled task (live · internal; distributed as a .skill file) → `#sp-writer` SP Writer, a Claude Skill for service-desk documentation: raw troubleshooting notes / pasted ticket / old Word-PDF doc / spoken walkthrough → a SweetProcess procedure ("SP") draft in XL.net's house format (prefixed title — client name for client SPs, XL.net for internal, software name for generic; 3–7 search tags; purpose statement; short numbered steps, one action or decision each; decision steps with ANSWERS routing, every path traced to the End step, renumber after edits; bold instead of code spans so formatting survives the paste; output as markdown + matching .docx; credentials only as BitWarden entry names; missing facts asked or `[Confirm: …]`-marked, never invented; no publish step — never creates the SP in SweetProcess itself, a tech reviews and publishes) (live · internal; three-facet sub-grid: Every Path Reaches End / Flagged, Never Filled In / Two Files, Then a Tech; closing anchor-links `#ticketscribe` + `#beacon`, Beacon referenced future-tense to match its final-setup badge)), grouped into five `aria-label`ed `<section>` wrappers with visual kicker labels (Engine / What It Runs / Client Delivery / The Access Layer / What We're Testing; "X in — Y out" taglines are the Client Delivery pair's signature only), mid-page (after `#onboarding-toolkit`) + closing CTAs → `/builders` |
| `/builders` | **dynamic** server component (`force-dynamic`) | "AI Builders" commercial page: 2028 thesis hero, two offerings (§5.10) — Virtual Workshop $995 one-time (Aug 27 8am–12pm CT, capped at 8; CTA is an external link to the Ticket Tailor event page `WORKSHOP_TICKETS_URL` labeled "Reserve August 27", not Stripe) and Stripe-purchasable AI Builder Cohort $495/month (max 6, auto-renew disclosure on-card). The workshop card's badge row is time-gated in three windows off two constants (`JULY_SESSION_STARTS` `2026-07-30T13:00Z`, `WORKSHOP_STARTS` `2026-08-27T13:00Z` — this gating is why the page is force-dynamic): before July 30 it stacks two full-width status strips (`badge--warn` "Next session · July 30 · Sold out" with no dot, then `badge--light` + dot "August 27 · Booking open") and the proof line reads "July 30 filled all 8 seats"; between the dates a single "Next session: August 27" badge with past-tense sold-out proof line; after Aug 27 the "Next date: TBA → /contact" state. All three badges carry `self-start` so the subgrid can't stretch the cohort badge to the stacked strips' height. Below pricing: free May webinar (self-hosted MP4, §5.10) + June 18 recap YouTube short; objection panels; CTA → `/contact` |
| `/builders/thanks` | dynamic server component, `robots: noindex` | Stripe Checkout `success_url`; reads `?session_id`, retrieves the session server-side (status must be `complete`) to show offering name + receipt email, generic copy on any lookup failure |
| `/contact` | static server component | Contact info only — **no form** (email `Tron.Netter@ai.xl.net`, phone/SMS (872) 350-4325, points users at the chat widget); links to `/texting` |
| `/login` | client component | Sign-in card in `<Suspense>`; reads `?redirect`, `?error`, `?message`; links to `/api/auth/{google,microsoft}/start`; error codes map to friendly text via the module's `loginErrorMessages` (`@aicompany/core/auth/login-errors`), `?message` taking precedence. `login/layout.tsx` sets `robots: noindex` |
| `/texting` | server component shell + module client wizard | Page shell (heading + footnote) kept from the legacy page; the wizard itself is the module's `<TextingWizard {...toTextingWizardProps(siteConfig)}/>`: session check → phone + consent checkbox (`texting.consentText` + links to the legal pages) → 6-digit code entry (resend / change-number) → "Verified" panel. Signed-out users get a Sign In link with `?redirect=/texting`; already-opted-in users land on the done state. `texting/layout.tsx` holds the metadata |
| `/account` | server component shell + module client panel | Page shell (heading) mirrors `/texting`; the panel is the module's `<AccountSettings {...toAccountSettingsProps(siteConfig)}/>` (v1.2.0, module §5.10): texting status from `GET /api/texting/settings`, remove-number via `POST /api/texting/remove`, prompt-card preference. Lives at `texting.settingsPath` — the SMS prompt card's dismiss note links here and the card is suppressed on this route. `account/layout.tsx` holds the metadata (mirrors `texting/layout.tsx`) |
| `/privacy` | thin wrapper (server component) | Renders the module's `<PrivacyPolicyPage config={siteConfig} lastUpdated="July 2026"/>` — the policy is generated from the same config values the code enforces (tracking flags, cookie name, retention windows, enabled channels). Keeps the page's own `metadata` export |
| `/sms-terms` | thin wrapper (server component) | Renders the module's `<SmsTermsPage config={siteConfig} lastUpdated="July 2026"/>` — program description, opt-in methods, verification mechanics from `texting.verification`, frequency/rates, STOP/HELP, carriers, privacy cross-link, contact. Keeps the page's own `metadata` export |
| `/governance` | **dynamic** server component (`force-dynamic`) | AI Governance builder landing (§5.12): signed-out visitors get a crawlable showcase (hero + static "representative session" vignette + deliverables + stat strip + FAQ + closing sign-in panel, all CTAs to `/login?redirect=/governance`; `title.absolute` metadata + a `WebApplication` JSON-LD node referencing the layout's `#org` entity, price-0 offer); signed-in users get their project list + the create panel (kind picker, domain confirm/override, acknowledgment checkbox, 30-day + third-party-AI disclosures) |
| `/governance/[id]` | dynamic server shell + client workspace, `robots: noindex` | The §5.12 project workspace: research progress, one-question-at-a-time Q&A beside the live document pane, review/confirm, always-available Word-friendly downloads. Signed-out → redirect to `/login?redirect=/governance/<id>` |
| `/blog` + `/blog/[slug]` | thin wrappers over `@aicompany/core/blog/{index-page,article-page}` (`revalidate = 60`) | AI-news blog (§5.11, module §19). Index lists published articles (custom Tron-voiced copy from `blog.copy`); `[slug]` renders one `ArticleDoc` deterministically with the AI-authorship disclosure + `Article` JSON-LD. Metadata (canonical, OG, `noindex` for gate-failed rows) from `blog/metadata` |
| `/methodology` | custom static page (server component) | Editorial methodology + corrections policy (added 2026-07-14 after the process reviews): pipeline description, the 12 reader-facing checklist items, corrections contact, funding/COI statement. Referenced by `blog.authorship.methodologyUrl` → `publishingPrinciples` in the Article JSON-LD (module §19.4); cleared the standing config:check WARN |

Header nav: Home, Our Work, AI Builders, **Governance (`/governance`)**, **AI News
(`/blog`)**, Contact. The footer links
Home, Our Work, AI Builders, AI Governance, AI News, Contact, Text with Tron Netter (`/texting`), Account
(`/account` — the §12.7 account affordance the module's `<UserMenu/>` deliberately does not
grow), Privacy Policy, SMS Terms, and the main xl.net site. The homepage carries teaser panels for `/work`
and `/builders` between the capabilities grid and the closing CTA. Sitemap entries: `/`,
`/work`, `/builders`, `/governance`, `/contact`, `/methodology`, `/privacy`, `/sms-terms`, `/texting`, plus the module's
`blogSitemapEntries` (the `/blog` index once ≥1 published, and each indexable article —
noindexed/gate-failed rows excluded). `sitemap.ts` exports `revalidate = 3600` — without
it Next bakes the route at build time and nightly-published articles never enter the
sitemap between deploys. RSS at `/rss.xml`.

**Root layout** provides: metadata (title template `%s | XL.net AI`, `metadataBase` from
`NEXT_PUBLIC_BASE_URL`, OG/Twitter), the module's `<OrgJsonLdScript config={siteConfig}/>`
(schema.org `Organization` with `name` XL.net AI, `legalName` XL.net, `url` https://ai.xl.net,
`hasCredential` SOC 2 Type II + ISO 27001:2022 from `seo.organization`), the module's
**pre-paint theme script** (`themeScript(true)` from `@aicompany/core/components/theme-script`:
reads `localStorage.theme` / `prefers-color-scheme` / dark-first default, sets `.dark` or
`data-theme="light"` on `<html>` before first paint), sticky header (logo, nav, module
`<ThemeToggle>`, module `<UserMenu {...toUserMenuProps(siteConfig)}>`), footer, and — on every
page — the module `<ChatWidget {...toChatWidgetProps(siteConfig)}>` and
`<SmsPromptCard {...toSmsPromptCardProps(siteConfig)}>`, plus the host's `<FuturismFx>`
and `<Script src="/fx.js" strategy="afterInteractive">`.

**Styling:** Tailwind v4 + a custom "Elegant Futurism" design system (`src/app/futurism.css`,
~760 lines). Dark-first; light mode = `data-theme="light"` on `<html>`. Tokens are `oklch()` CSS
custom props (`--xl-bg-*`, `--xl-light*` cyan, `--xl-sand*` warm, `--xl-text*`, `--xl-line*`).
Fonts from Google Fonts: Julius Sans One (display), Manrope (UI), JetBrains Mono (data).
Dark variant: `@custom-variant dark (&:where(.dark, .dark *))`.
Base behaviors: `html` gets `scroll-behavior: smooth` **plus `scroll-padding-top: 6rem`** so
same-page anchor targets clear the sticky header (smooth scroll reverts to `auto` under
`prefers-reduced-motion`); prose links inside panels (`.panel p a`) are underlined
(`text-underline-offset: 3px`, decoration `--xl-light-dim`) — a non-color cue per WCAG 1.4.1,
since link-vs-body contrast is below 3:1.

`futurism.css` §1c additionally defines every `--site-*` token of the module theme contract
(`packages/aicompany/architecture.md` §4.2) in both themes (`:root` dark defaults +
`[data-theme="light"]` overrides), mapped onto the `--xl-*` values: bg/surface/text/muted/line
→ the futurism surfaces and text ramps, accent → `--xl-light` cyan, accent-2 → `--xl-sand`,
status → `--xl-ok/warn/danger`, chat bubbles → the legacy TronNetterChat pairs (user:
`--xl-light` on `--xl-bg-0`; persona: `--xl-bg-2`/`--xl-text`), fonts → the three futurism
font stacks, radius `0px / 0.5rem / 0px` (square hairline design; bubbles keep the legacy
rounded-lg), glow shadows, `--site-focus-ring: 2px solid var(--xl-light-dim)`, motion
`--dur-fast`/`--ease-drift`.

**Client components** — chat widget, theme toggle, user menu, and SMS prompt card come from
`@aicompany/core/components/*` (behavior specified in `packages/aicompany/architecture.md`
§4.2, §5.8, §5.10), fed by the serializable prop mappers in `@aicompany/core/components/props`
(`toChatWidgetProps` / `toSmsPromptCardProps` / `toUserMenuProps`; the chat widget posts to
`/api/persona/chat`, session checks hit `/api/auth/session`, prompt-card events
`/api/auth/sms-prompt`). The legacy host versions (tron-netter-chat, theme-toggle, user-menu,
sms-prompt-card, use-session) were deleted at adoption. Host-specific components
(`src/components/`):

- `email-link.tsx` — `<EmailLink email label? className?>`: mailto link wrapped in Cloudflare
  `<!--email_off-->` comments (via `dangerouslySetInnerHTML` — React can't emit HTML comments)
  so the zone's Email Address Obfuscation doesn't rewrite it into a `/cdn-cgi/l/email-protection#…`
  link that 404s for crawlers/no-JS visitors. Use it for every visible email address
  (footer, contact, privacy, sms-terms).
- `checkout-button.tsx` — `"use client"` buy button for a §5.10 offering: POSTs
  `{offering}` to `/api/checkout`, follows the returned Stripe-hosted Checkout URL
  (`window.location.assign`), shows loading/error states inline. Card entry never
  happens on-site.
- `futurism-fx.tsx` — IntersectionObserver adds `.is-visible` to `.rise` elements; re-runs on route change.
- `public/fx.js` — defines the `<xl-dust>` custom element (canvas dust motes; `density` attr,
  default 36; colors from `--xl-light`/`--xl-sand`; respects `prefers-reduced-motion`).
  JSX typing in `src/types/custom-elements.d.ts`.

---

## 5. Backend (Next.js route handlers)

Every channel/auth/admin/tracking handler is **provided by @aicompany/core v1.4.0** and
mounted as a thin wrapper — one file per route, contents exactly
`export const <METHOD> = create<X>Handler(siteConfig)` plus the two imports (canonical
wrapper table: module README §2.1). Behavior, validation, rate limits, and the
panel-mandated hardening (open-redirect guard, server-enforced session `exp`, chat
sessionId validation, dropped-inbound alerts, AI-disclosure lines) are specified in
`packages/aicompany/architecture.md`; the subsections below keep only the
aiwebsite-specific facts. Admin authorization remains `ADMIN_EMAIL`-allowlist membership
(no DB role); OAuth **callbacks** live under `/auth/...`, not `/api/auth/...` (they must
match the redirect URIs registered with Google/Microsoft).

**Wrapper-route table** (mount in this repo → module factory · module doc §):

| Mount | Module factory (`@aicompany/core/...`) | Module § |
|---|---|---|
| `POST /api/tron-netter/chat` | `createChatHandler` · `channels/chat` | §5.1 |
| `POST /api/tron-netter/sms` | `createSmsHandler(siteConfig, {mountPath: "/api/tron-netter/sms"})` · `channels/sms` | §5.2 |
| `POST /api/tron-netter/sms/status` | `createSmsStatusHandler` · `channels/sms` | §5.2/§5.12 |
| `POST /api/webhooks/resend` | `createInboundEmailHandler` · `channels/email` (thin wrapper since v1.6; Troy.Netter@ai.xl.net budget-approval mail routes via `channels.email.onInbound` in site.config.ts — sole-recipient Troy mail is "handled", mixed recipients delegate so Tron still answers) | §5.3/§5.12 |
| `GET /api/account/export` | `createAccountExportHandler` · `account/data` (v1.6; extras: governance projects + contact submissions) | §5.13 |
| `POST /api/account/delete` | `createAccountDeletionHandler` · `account/data` (v1.6; governance_projects cascade via users FK; beforeDelete removes contact_submissions by email) | §5.13 |
| `GET /api/auth/google/start` / `GET /auth/google/callback` | `createOAuthStartHandler` / `createOAuthCallbackHandler` · `auth/oauth-google` | §5.5 |
| `GET /api/auth/microsoft/start` / `GET /auth/microsoft/callback` | same pair · `auth/oauth-microsoft` | §5.5 |
| `GET /api/auth/session` | `createSessionHandler` · `auth/handlers` | §5.5 |
| `POST /api/auth/logout` | `createLogoutHandler` · `auth/handlers` | §5.5 |
| `GET /api/health` | `createHealthHandler` · `auth/handlers` | §5.5 |
| `POST /api/texting/start` / `POST /api/texting/verify` | `createTextingStartHandler` / `createTextingVerifyHandler` · `channels/texting` | §5.10 |
| `POST /api/auth/sms-prompt` | `createSmsPromptEventHandler` · `channels/texting` | §5.10 |
| `POST /api/internal/track` | `createTrackHandler` · `tracking/track-api` | §5.6 |
| `src/middleware.ts` | `createTrackingMiddleware(siteConfig, {protectedPrefixes})` — the module's five default CSRF prefixes **plus the host's `/api/checkout` and `/api/governance`** | §5.6 |
| `GET/POST /api/admin/messages` | `createAdminMessagesHandler` · `admin/api` | §5.6 |
| `POST /api/admin/mailbox/send` | `createAdminMailboxSendHandler` · `admin/api` | §5.6 |
| `GET/POST /api/admin/knowledge/refresh` | `createAdminKnowledgeRefreshHandler` · `admin/api` (wrapper adds `runtime = "nodejs"`) | §5.6 |
| `/admin/<key>` pages + layout | module admin page components + `<AdminLayout>` | §5.6 |
| `src/app/sitemap.ts` / `robots.ts` | `createSitemap(siteConfig, entries)` / `createRobots` · `seo/*` | §5.9 |

Not mounted (disabled features): magic-link auth (`auth.providers.magicLink: false`).

**Host-owned (non-module) routes:** `POST /api/checkout` — Stripe Checkout Session
creation for the `/builders` offerings (§5.10) — and the `/api/governance/*` family
(§5.12). Neither is part of @aicompany/core.

### 5.1 Web chat — mounted at `POST /api/tron-netter/chat`

Provided by `createChatHandler(siteConfig)` (module architecture.md §5.1): body/sessionId
validation, memory identity resolution (§5.9), envelope construction, the reduced NDJSON
widget stream (`token/answer/done/error`), 502 on brain failure. aiwebsite facts:

- `persona.sessionIdPrefix: "tron"` — sessionIds must match `/^tron_…/` (historical
  `brain_messages` rows use this namespace; the validation blocks cross-channel session
  replay of the deterministic `sms-<E.164>` / `email2-…` ids).
- Envelope carries `brainIdentity: TRON_NETTER_IDENTITY`, system prompt = Tron persona rules
  + knowledge doc (both in site.config.ts), `invocation:{maxOrchestratorPhase:1}`,
  `disabledTools` = full brain tool list, `markdownMode:"html"`, **no `groupName`** (§5.9);
  120 s brain timeout (`brain.timeouts.chatMs`).
- Failure copy: `chatWidget.unavailableMessage` ("Sorry, I encountered an error…" — legacy
  copy verbatim); `chatWidget.disconnectedMessage` overrides the module default ("The
  connection dropped mid-reply. This answer may be incomplete." — site copy avoids em
  dashes).
- **NOTE (pre-go-live):** the module's `toChatWidgetProps` hardcodes the widget's POST path
  as `/api/persona/chat`, but the wrapper is mounted at the legacy `/api/tron-netter/chat`
  — the two must be reconciled (move the wrapper or override the prop) or the widget
  cannot reach the handler.

### 5.2 SMS — mounted at `POST /api/tron-netter/sms` (+ `/status`)

Provided by `createSmsHandler(siteConfig, {mountPath:"/api/tron-netter/sms"})` (module
§5.2): Twilio signature verification (HMAC-SHA1 over `site.baseUrl + mountPath`, fail →
403 — **the Twilio console webhook URL must byte-match**
`https://ai.xl.net/api/tron-netter/sms`), keyword short-circuits, ACK-then-work (empty
TwiML, brain call in `after()`), FORGET erasure flow (§5.9), first-contact memory
disclosure, reply via Twilio REST capped at 1200 chars (since v1.2.0 an over-long answer
is truncated with `"…"` ahead of the reserve so the AI-signature/notice footer always
survives — previously a blind `slice(0, 1200)` could amputate it). aiwebsite facts:

- Number **+1 (872) 350-4325** (`channels.sms.phoneNumber`), shared Twilio account with
  itsupportchicago (admin views stay number-scoped, §5.6).
- Legacy keyword list partitioned per the module contract: `optOutKeywords`
  `stop stopall unsubscribe cancel end quit` (carrier compliance replies come from the
  Messaging Service's Advanced Opt-Out) + `silentKeywords` `yes help info`
  (short-circuited with no reply — aiwebsite parity). `start`/`unstop` left
  `silentKeywords` at v1.2.0: they are covered by the module's `optInKeywords` default
  (`["start","unstop"]`), which records a re-opt-in `sms_consent_logs` row and never
  reaches the brain (runtime order opt-out → opt-in → silent; keeping them silent would
  have config:check WARN with opt-in winning anyway).
- Registration invite (v1.2.0, module §5.10): an unlinked texter's eligible brain reply
  carries a one-time `texting.invite` line (module default copy — memory-on variant)
  pointing at `/texting`; the durable once-ever record is an `sms_notices` row
  (`kind='registration_invite'`, §6) — pre-existing unlinked texters receive it once on
  their next eligible reply after the v1.2.x bump (recorded module panel decision S8).
  The memory-off `storageNotice` never fires here (`memory.enabled: true`).
- `sessionId: "sms-<From E.164>"`; every texting number stores
  (`store_persistent`/`private_to_requester`, §5.9); SMS addendum targets <300 chars, ≤900.
- FORGET keyword + confirmation/failure copy and the first-contact notice line live in
  `memory.*` of site.config.ts (STOP stops messages but keeps memories; FORGET erases
  memories but does not stop messages).
- Brain-failure apology: `channels.sms.failureMessage` ("Sorry, I hit a snag…" — legacy
  copy verbatim).

### 5.3 Inbound email — mounted at `POST /api/webhooks/resend`

Provided by `createInboundEmailHandler(siteConfig)` (module §5.3): Svix signature
verification (fail → 401), fire-and-forget handling, recipient/sender filters with
dropped-inbound alerts, quoted-history/signature stripping from the model prompt, the
fail-closed sender-authenticity gate (Authentication-Results parsing → memory bucket,
§5.9), reply with signature block + AI disclosure + quoted original. aiwebsite facts:

- Mailbox **Tron.Netter@ai.xl.net** (`channels.email.mailbox`); the Resend account is
  shared with itsupportchicago.net, so `siblingSites:
  ["chi@itsupportchicago.net", "itsupportchicago.net"]` guards against answering the
  sibling persona's mail and persona↔persona reply loops.
- `threading: "sender"` — legacy behavior kept at parity: brain session per sender
  (`sessionId: "email2-<addr>-<thread>"`), not the module's per-subject refinement.
- Memory gate pins `memory.emailAuthservId: "amazonses.com"` (Resend inbound is
  fronted by Amazon SES; verified against a real inbound 2026-07-10), `allowSpfOnly: false`
  (DKIM-aligned only). **Run the go-live probe**: send a real Gmail message + a spoofed one
  (`swaks --from victim@gmail.com` from an unrelated host) and read the logged auth-verdict
  lines; correct `emailAuthservId` if Resend stamps a different authserv-id — if it stamps
  none, email memory silently stays off (fail-closed, by design).
- Reply signature: name / AI Agent, XL.net / mailbox / (872) 350-4325 — call or text / the
  one-line memory disclosure with the /privacy link / https://ai.xl.net. Oversight BCC to
  adam@xl.net as always. 300 s brain timeout (`brain.timeouts.emailMs`).
- Brain-failure reply copy: `channels.email.failureMessage` (module default — the legacy
  route sent nothing on failure; this is a panel-mandated hardening delta).
- **Blocked-sender forwards (module §5.3 v1.9, default-on):** daemon-class senders
  (noreply/donotreply/mailer-daemon/postmaster) to Tron's mailbox forward **in full**
  to adam@xl.net (`oversight.alertEmail`) — subject
  `[aiwebsite] FWD blocked-sender inbound: …`, byte-exact text relay, RFC 3834
  auto-response-suppress headers, Reply-To self-addressed. Rolling caps (10/sender,
  50/mailbox per 24 h) and failed sends fall back to the old throttled WARN notice.
  No config set on this host — module defaults (`forwardBlockedSenders: true`,
  `forwardBlockedTo` → alertEmail).

### 5.4 OAuth (Google + Microsoft), session, logout, health

Provided by the module's auth handlers (module §5.5): state-cookie flow, open-redirect
guard, rate-limited starts, `handleOAuthUser` upsert + `auth_logs`, stateless HMAC session
cookie with server-enforced `exp`, `smsPromptEligible` computed server-side (fails toward
silence). aiwebsite facts:

- Cookie name **`aix_session`** (`auth.sessionCookieName` — historical name, existing
  sessions survive adoption), TTL 30 days; `SESSION_COOKIE_SECRET` ≥32 chars.
- Registered redirect URIs: `https://ai.xl.net/auth/{google,microsoft}/callback`
  (+ localhost variants) — GCP project `xl-website-1682362315172` client "ai.xl.net";
  Entra app `e66a2e8f-c1c1-4b63-9ffe-245db7d5363c` (§11).
- `isAdmin` = email ∈ comma-separated `ADMIN_EMAIL` (currently adam@xl.net).
- `GET /api/health` → `{status:"ok"}` (PM2 readiness, watchdog, deploy verification, the
  external uptime monitor, and the module v1.17.0 dev-box synthetic sweep's
  post-deploy settle gate — module §9.8).
- Synthetic monitoring (module v1.17.0, §9.8): `deploy/synth-inventory.json`
  lists the public pages/markers/feeds the dev-box sweep checks every 15 min
  (all alert-only, `[aiwebsite] SYNTH` mail grammar); `SYNTH_PAGES` in
  site-deploy.env adds `/blog` + `/texting` to the on-VM watchdog as
  alert-only local checks; `SYNTH_HEARTBEAT=1` dead-mans the sweep runner via
  `data/synth-last-sweep`.

### 5.5 `src/lib/` — what remains host-owned

The legacy `src/lib/` modules (brain-client, auth, oauth-helpers, twilio, texting,
email/send, tron-netter/persona, rate-limit, auth-guard, admin/format,
seo/classify-referrer, visitor-id) were deleted at adoption — their responsibilities are
**module-provided** now:

| Concern | Provided by (@aicompany/core) | Module doc |
|---|---|---|
| brain client (Bearer, `GET /v1/tools` disable list, envelopes) | `channels/*` internals | §5.1–§5.4, §7 |
| session cookie, OAuth helpers, `requireAdmin` | `auth/*` | §5.5 |
| Twilio REST send (1200-char cap), Resend send (**mandatory oversight BCC**, AI disclosure) | channel internals | §5.2/§5.3, §1 invariants |
| persona system prompt (knowledge doc read, **mtime-cached hot reload**, <1000-char corrupt fallback) | `persona/system-prompt` | §5.1 |
| texting consent/verification constants, `normalizeUsPhone` | `channels/texting` | §5.10 |
| in-memory rate limiter (per-process, 1 PM2 fork instance) | normative table | §5.7 |
| brain-table reads (admin) + memory writes (§5.9) | `db/brain-read`, `memory/brain-tables` | §5.6, §18 |
| referrer classification, MaxMind IP→org resolution + ISP ASN filter | `tracking/*`, `seo/*` | §5.6, §5.9 |

Host-owned remainder:

| Module | Responsibility |
|---|---|
| `db/schema.ts` | composed schema: module factories for the 10 shared tables + host-owned `contact_submissions` (§6) |
| `db/index.ts` | calls the module's `registerTables()` with the composed tables (magicLinks omitted — provider off) and re-exports the module's lazy drizzle proxy as the historical `db` |
| `stripe/offerings.ts` | the two purchasable AI Builder offerings (id, name, copy, USD-cent amount, Checkout mode, price-override env var) consumed by `/api/checkout` and `/builders/thanks` (§5.10) |

Values that were constants in those files (consent text, TTLs, addenda, fallback tool
list, failure copy, retention windows) live in **site.config.ts**, ported verbatim.

### 5.6 Admin console (`/admin/*` + `/api/admin/*` + tracking)

The console is @aicompany/core's admin (module architecture.md §5.6), mounted as thin
wrappers — plus one host-owned page, `/admin/governance` (§5.12 "Admin review
console"), added to the nav via `admin.extraNav` and self-guarding like every module
page. Each `src/app/admin/<key>/page.tsx` renders the module page component with
`{config, searchParams}` and sets `dynamic = "force-dynamic"` (the module components
don't). `src/app/admin/layout.tsx` wraps the module `<AdminLayout config>` — nav built
from `admin.enabledPages` (legacy ADMIN_NAV order preserved in site.config.ts; labels
are module-fixed, so legacy "Chats"/"SMS" render as "Conversations"/"Messages"),
`robots: noindex,nofollow` via the module's `adminMetadata` — and keeps its own
session check + redirect to `/login` as defense-in-depth on top of the module layout's
identical guard. Pages style via the module's `--site-*` tokens. Every data source
degrades independently (try/catch → empty state) so a missing table or stopped brain-api
never 500s the page.

| Page | Data | Notes |
|---|---|---|
| `/admin/analytics` | `users`, `auth_logs`, `page_visits`, brain usage | stat cards (users, 30d visits/sessions, 30d brain spend), usage-by-model table, recent sign-ins |
| `/admin/conversations` | `brain_messages` (read-only) | all channels; filter `?channel=chat\|sms\|email`, paginate `?offset`, transcript via `?session=<id>` |
| `/admin/messages` | Twilio REST API (no local storage) | client component; list is always scoped to `TWILIO_PHONE_NUMBER` (`To=`/`From=`) because the Twilio account is **shared with itsupportchicago**; "all" = merged first pages of both directions (no pagination), direction filters paginate via Twilio `next_page_uri`. Reply/compose form → `POST` |
| `/admin/texting` | `users`, `sms_consent_logs`, `sms_prompt_events`, `phone_verifications` | SMS opt-in operations (§5.7/§5.8): stat cards (verified numbers all-time, opt-ins 30d all-source distinct users, prompt conversion % = opted-in ∩ shown / shown, don't-ask-again); 3-stage funnel table (shown → clicked → verified, distinct users, hand-rolled bars); consent audit trail (last 50, `<details>` disclosure of consentText/UA/page); verification attempts with honest outcomes — **VERIFIED requires a matching consent-log row** (consumed_at alone also means retired/superseded), BLOCKED = attempts > 5, RETIRED, EXPIRED, LIVE. Read-only; opt-outs live at the carrier |
| `/admin/mailbox` | `brain_messages` email sessions + `admin_emails` | thread list from email sessions; thread view merges Tron's turns with manual admin sends (matched by sessionId); compose/reply → `POST /api/admin/mailbox/send`; reply-to derived from requesterId, subject from the sessionId's thread slug |
| `/admin/calls` | `brain_phone_calls` (read-only) | expandable per-call transcripts (JSON `[{role,text}]`) |
| `/admin/contacts` | derived — no contacts table | merges OAuth users + brain requesters (SMS phones, `email:` addrs) + phone-call numbers into one directory (identifier, verified phone, channels, interaction counts, first/last seen). **Identity merge on verified phones** (post-pass after all sources load): a `users.phone` match folds that number's SMS/voice row into the email row (possession-proven by the §5.7 double opt-in, so aggressive merging is safe) — Phone column shows the E.164 + "verified" badge; anonymous numbers stay separate with no badge; a merged user's firstSeen may predate their account (texted before signing in — correct) |
| `/admin/companies` | `page_visits` ⋈ `ip_orgs` | orgs reading the site; ISP ASNs filtered out |
| `/admin/seo` | `page_visits` | 30-day first-party traffic: stat cards (views/sessions/visitors/bounce), source classification, referring domains, daily bars, top pages, session depth. **GSC/Semrush not wired up** |
| `/admin/knowledge` | `brain_memories` (read-only) | rows + per-source_type stats (row sizes matter — voice injects all public rows); button triggers the crawl |
| `/admin/governance` | `governance_projects` ⋈ `users`, `governance_usage`, `page_visits` | **host-owned** (not a module wrapper): read-only §5.12 usage review — stat tiles, per-user rollup, project list with status/liveness/failed-turn chips + deletion countdown, 14-day counters. Metadata only, content columns never selected; full contract in §5.12 "Admin review console" |

API routes (module factories from `@aicompany/core/admin/api`; every handler runs the
module's `requireAdmin()`, middleware adds CSRF):

- `GET/POST /api/admin/messages` — `createAdminMessagesHandler(siteConfig)`: Twilio list
  proxy always scoped to the persona's number (`?dir=in|out`, `?page=` next_page_uri
  passthrough validated to stay number-scoped) / send SMS (To normalized as a US number,
  body ≤1600, **refused 403 without a live `sms_consent_logs` opt-in** — a hardening delta
  vs the legacy route, which sent to any E.164). Manual sends do NOT enter Tron's
  conversation history.
- `POST /api/admin/mailbox/send` — `createAdminMailboxSendHandler(siteConfig)`:
  `sendEmail()` (Resend, mandatory oversight-BCC to adam@xl.net), then records the send in
  `admin_emails` (success flag either way).
- `GET/POST /api/admin/knowledge/refresh` — `createAdminKnowledgeRefreshHandler(siteConfig)`:
  status / spawn `scripts/refresh-knowledge.mjs` detached (logs →
  `data/knowledge-refresh-manual.log`); module-level flag → 409 while running (not
  coordinated with the nightly timer). NOTE: the handler spawns `<repo
  root>/scripts/refresh-knowledge.mjs`, which does not exist in this host — the nightly
  timer runs the module's crawler from `packages/aicompany/scripts/` (§8); until a
  host-root shim exists, the manual refresh button spawns a missing file.

**Page-view tracking:** `src/middleware.ts` (GET, non-API/non-admin/non-static paths, bot-UA
filtered, **prefetches excluded** — requests carrying `Next-Router-Prefetch` or
`Sec-Purpose/Purpose: prefetch` headers are speculative loads, not views; without this every
`<Link>` render inflates its target's counts, and the SMS prompt card's CTA additionally sets
`prefetch={false}` — only when `INTERNAL_TRACK_SECRET` is set — fail-closed) POSTs
`{path, referrer, ip (cf-connecting-ip ∥ x-forwarded-for), userAgent, sessionHash =
hash(ip|ua|date), landingUrl, utm*}` fire-and-forget to `POST /api/internal/track`
(`x-track-secret` gated), which dedups same session+path within 30 s, inserts `page_visits`,
and warms `ip_orgs` via `resolveIpOrg()` in the background.

### 5.7 SMS opt-in & phone verification (`/texting` + `/api/texting/*`)

Provided by @aicompany/core's texting handlers (module §5.10). Verified (double) opt-in:
possession of the phone is proven with a texted code before the number ever touches
`users`, and the exact consent language is archived per opt-in. Both routes require a
session (401 otherwise); the consent text (legacy `SMS_CONSENT_TEXT`, verbatim — the audit
trail must stay comparable) and verification constants (`ttlMin: 10, maxAttempts: 5`) live
in the `texting` block of site.config.ts.

- `POST /api/texting/start` — body `{phone, smsOptIn}`. Rejects unless `smsOptIn === true`
  (400); normalizes the phone via `normalizeUsPhone()` (400 if invalid); rate-limits per
  user **and** per phone (3/10 min each, 429 + `Retry-After` — code sends cost Twilio money);
  409 if the number belongs to another account (`users.phone` is UNIQUE). Then: generate a
  `crypto.randomInt` 6-digit code → `sendSms()` the code (send failure → 502, nothing
  stored) → retire the user's previous live codes (`consumed_at = now()`) → insert
  `phone_verifications` (SHA-256 hash of the code only, 10-min expiry, requester IP).
- `POST /api/texting/verify` — body `{code}` (6 digits). Rate-limited 10/10 min per user.
  Loads the user's newest unconsumed row; expired/absent → 400 "request a new one".
  **Increments `attempts` before comparing** (parallel guesses can't beat the cap; >5 → 400)
  then compares SHA-256 hashes via `timingSafeEqual`. On match: mark consumed, set
  `users.{phone, phone_verified_at, sms_opt_in_at}` (unique-violation race → 409), append an
  immutable `sms_consent_logs` row (`texting.consentText`, IP, user agent, page URL), then in
  `after()`: **memory-identity migration** `migrateBrainRequester("user:<uuid>", phone)` (§5.9
  — the verified phone becomes the canonical Tron memory id; never blocks or rolls back
  verification, idempotent, self-heals on the user's next chat/SMS if it fails here) and a
  best-effort CTIA opt-in confirmation SMS (frequency varies / msg&data rates / STOP / HELP).

Since v1.2.0 the `/account` settings surface (module §5.10) adds two more wrappers:

- `GET /api/texting/settings` — `createTextingSettingsHandler(siteConfig)`: the
  `<AccountSettings/>` data source (linked phone, verification/opt-in timestamps,
  latest consent-log posture, prompt-dismissed state). Session-gated (401),
  rate-limited, `Cache-Control: no-store, private`.
- `POST /api/texting/remove` — `createTextingRemoveHandler(siteConfig)`: unlinks the
  account's number. Remove IS an opt-out, write order normative: append the opt-out
  `sms_consent_logs` row FIRST (failure → 500, number stays linked), then null
  `users.{phone, phone_verified_at, sms_opt_in_at}` (`sms_prompt_dismissed_at`
  untouched — a UI preference is never consent), then in `after()` migrate the brain
  memory bucket back to `user:<uuid>` (§5.9, recycled-number safety). Idempotent when
  no number is linked.

The `<AccountSettings/>` panel copy is the module's `DEFAULT_TEXTING_SETTINGS_COPY`
verbatim (accepted config:check clone-smell WARN at adoption — voicing the 34
`texting.settings` fields for Tron is a recorded follow-up, like §5.11's methodology WARN).

Opt-**out** remains carrier-level: STOP/HELP keywords are handled by Twilio Advanced
Opt-Out before webhooks fire (§5.2); the site does not process them. `users.sms_opt_in_at`
is therefore "user opted in via /texting", not a live deliverability flag — but the
account holder can now also unlink+opt-out in one action from `/account` (§4).

### 5.8 SMS prompt card (`<SmsPromptCard>` + `POST /api/auth/sms-prompt`)

Soft acquisition surface for §5.7, designed and design/architecture-audited 2026-07-09:
signed-in users with no registered number see a dismissible card (frontend behavior in §4)
pointing at `/texting`. Server pieces:

- Eligibility is computed **server-side** in `GET /api/auth/session` (`smsPromptEligible`,
  §5.4) — the client never derives it from raw fields, and a failed DB read suppresses the
  card rather than re-soliciting an opted-in user.
- `POST /api/auth/sms-prompt` — body `{event: "shown"|"clicked"|"snoozed"|"dismissed"}`;
  session required (401), rate-limited 20/10 min per user, 400 on unknown event. Appends to
  `sms_prompt_events` — the funnel surfaced on `/admin/texting` (§5.6): shown → clicked →
  verified, where verified = a `sms_consent_logs` user who was shown the card in-window
  (the CTA's `utm_source=sms_prompt` remains in `page_visits` for /admin/seo attribution
  but is not a funnel stage — prefetches made it unreliable as one). `dismissed` additionally sets
  `users.sms_prompt_dismissed_at` **idempotently** (`WHERE … IS NULL`) — a UI preference,
  deliberately NOT written to `sms_consent_logs` (that table stays a pure consent audit).
  Lives under `/api/auth/*` (not `/api/texting/*`) because it is preference/telemetry,
  not consent. CSRF: sameSite=lax cookie + benign mutation, same posture as `/api/texting/*`.
- Client dismissal state: "Not now" is client-local (14-day localStorage snooze; the 3rd
  snooze auto-sends `dismissed`), "Don't ask again" is the server column so it holds across
  devices. A failed `dismissed` POST fails open (card may return next session) — acceptable
  for a preference write. Since v1.2.0 (`texting.settingsPath: "/account"`): the card's
  dismiss note links `/account` so "Don't ask again" is never a dead end (module D5), and
  the card is suppressed on that route.

### 5.9 Tron Netter's cross-channel memory

Implemented by **@aicompany/core** (module `packages/aicompany/architecture.md` §18),
enabled and voiced via the `memory` block in `site.config.ts`; the host owns only the two
memory tables (module schema factories, registered in `src/lib/db/index.ts`) and the
nightly crawl's sweep backstop (§8). The brain buckets memories by the EXACT
`requester_id` string (recall predicate §7), so "shared memory across channels" is purely
an identity-string convention — **zero brain changes**:

| Situation | requesterId | memoryMode |
|---|---|---|
| verified phone on the account | the E.164 itself (`+1312…`) | `store_persistent` |
| signed-in user, no verified phone | `user:<uuid>` | `store_persistent` |
| signed-in user, widget memory toggle OFF | *(none)* | `do_not_store` |
| anonymous web visitor | *(none)* | `do_not_store` |
| SMS sender (any) | raw From E.164 | `store_persistent` |
| email sender, authenticated + registered | the user's canonical id above | `store_persistent` |
| email sender, authenticated, unregistered | `email:<addr>` | `store_persistent` |
| email sender, NOT authenticated | *(none)* | `do_not_store` |

The verified E.164 is canonical **because the brain's voice handler keys recall by caller
number** — web/SMS/email memories become recallable on phone calls for free (voice itself
never writes facts; realtime persona forces do_not_store). All persistent writes are
`privacyScope:"private_to_requester"`.

- **module `src/memory/identity.ts`** — `resolveWebChatIdentity` /
  `resolveSmsIdentity` / `resolveEmailIdentity` + `canonicalRequesterIdForUser` implement the
  table above, plus a lazy **self-heal**: if a verified user still has `user:<uuid>` data in
  the brain (verify-time migration failed or raced), the next chat/SMS re-runs the migration
  (process-level dedupe Set + cheap EXISTS pre-check).
- **module `src/memory/brain-tables.ts` write layer** (the ONLY sanctioned site-side brain
  writes, plus the crawl script's seed/site_crawl upserts — re-audit on every brain
  submodule bump):
  - `migrateBrainRequester(from, to)` — one transaction: re-keys `brain_memories` (private
    scope only), `brain_messages`, `brain_conversation_turns`; then duplicate-key supersede
    (same requester+key active twice → keep newest by `(updated_at, id)`, set `valid_until`
    on the rest — mirrors the brain's own supersedeFact; **never bumps `updated_at`** so
    original freshness decides). Idempotent. brain_events/_mentions deliberately not re-keyed
    (uq_events_signature conflict risk; orphans are inert), usage/billing rows keep old id.
  - `forgetBrainRequester(ids, phone)` — SMS FORGET erasure, one transaction, **hard DELETE**
    across: `archive_search_index` (**UNPREFIXED in Postgres** — missing from the brain's
    TABLE_NAMES prefix list), `brain_raw_turn_archive`, `brain_memory_events`,
    `brain_turn_state`, `brain_working_state`, `brain_event_mentions`, `brain_events`,
    `brain_memory_aliases`, `brain_memories` (private scope), `brain_conversation_turns`,
    `brain_messages`, + `brain_phone_calls.transcript := '[]'`. Sessions are collected before
    the transaction (the brain's pg adapter is one synchronous connection — long row-lock
    windows stall every brain turn, so keep the tx short; FORGET is rate-limited 3/hr).
    Retained on purpose (disclosed on /privacy): usage/billing metadata, consent logs,
    call-metadata rows minus transcript, deletion-audit row, the brain's thinking-debug
    store (Postgres `brain_thinking_passes` since the v1.99.2 re-adoption; pin now v1.100),
    server logs, oversight BCC copies.
  - `sweepEscapedSharedMemories()` — **poisoning guard, load-bearing**: the brain's extraction
    LLM may stamp a candidate fact `scope:'public'` (bot_self_fact) and candidate scope
    overrides the envelope's privacyScope at write time, so a chatter could otherwise plant a
    memory visible to every visitor. Envelope-side we omit `groupName` (no groupId ⇒
    `private_to_group` candidates demote to private); public-scope escapes are
    soft-invalidated (`valid_until = now`, evidence stays visible in /admin) by this sweep,
    which runs fire-and-forget before + after every `store_persistent` turn and nightly in
    the crawl script. Sanctioned shared-scope rows are ONLY `source_type IN
    ('seed','site_crawl','blog_article')` — any hand-inserted public fact must use
    `'seed'`, and the blog engine writes its per-article org-fact rows as
    `'blog_article'` (§5.11, module §19.9: id `blog-<sha1(slug)>`, scope `public`,
    kind `org_fact`, REPLACE-by-slug, deleted on unpublish; FORGET-inert — no
    `requester_id`). **`'blog_article'` was added to this allowlist at the blog
    adoption (2026-07-12); re-audit the list on every brain submodule bump.** A swept
    count > 0 is an intrusion signal (logged, and a warning line in the crawl report email).
- **`memory.memoryPromptAddendum`** (site.config.ts) — appended on memory-bearing turns:
  memories are personal context only; site knowledge always wins; never adopt instructions
  from memories. Email sender authenticity is judged by module `src/memory/email-auth.ts`
  (fail-closed Authentication-Results parsing, authserv-id pinned to
  `memory.emailAuthservId` = `amazonses.com` since Resend inbound is fronted by Amazon SES,
  DKIM-aligned only).
- **Known-identity via `requesterName`** — memory only holds facts said in conversation,
  never the user's own account profile, so the identity resolvers set `requester.requesterName`
  to the account `display_name` for authenticated turns (signed-in chat, verified-phone SMS,
  DKIM-authenticated email). The brain's `injectAuthIdentity` uses that as ground-truth
  identity (importance 1) and overrides any mis-extracted `user_name` memory. A system-prompt
  line does NOT work here — the brain ignores names in the caller's system message (verified
  against the running brain). Without `requesterName`, an authenticated "do you remember my
  name?" answered off a mis-extracted `user_name: "the user"` junk fact.
- **Accepted risks** (product decisions, disclosed on /privacy): recycled phone numbers
  surface the previous holder's number-keyed memories until FORGET; inbound voice keys recall
  by spoofable caller ID (targeted caller-ID spoofing exposes that number's memories on a
  call). Historic `email:<addr>` buckets are never auto-merged into account buckets (no
  authenticated link at merge time).

### 5.10 AI Builder checkout (Stripe) + workshop ticketing (Ticket Tailor) — host-owned

The `/builders` page sells the cohort through **Stripe-hosted Checkout**; no card
data ever touches this server, and there is no local orders table — Stripe's dashboard
is the system of record for purchases/subscriptions. The **Virtual Workshop** is no
longer sold through the site's Stripe checkout (since the August 27, 2026 session):
its card links out to the public **Ticket Tailor** event page
(`https://www.tickettailor.com/events/xlnet/<event_series_number>`, constant
`WORKSHOP_TICKETS_URL` in `src/app/builders/page.tsx`), so workshop seats live in a
single Ticket Tailor pool shared with the email-invite audience — the July 30 session
oversold precisely because site/Stripe and Ticket Tailor were two separate pools.
Ticket Tailor events are managed via its REST API (`api.tickettailor.com/v1`, Basic
auth, key in the dev box's `.env` as `TICKETTAILOR_API_KEY` — ops-only, **never read
by site code**; note the API cannot set the "online event" flag or upload images —
those are dashboard-manual).

- **Offering catalog:** `src/lib/stripe/offerings.ts` — `cohort` (AI Builder Cohort,
  $495/month subscription) only. Names, descriptions, USD-cent amounts, and Checkout
  `mode` live here.
- **Route:** `POST /api/checkout` with JSON `{offering: "cohort"}` →
  `stripe.checkout.sessions.create` → `200 {url}` (the Stripe-hosted page). Mode:
  `subscription` (`recurring: {interval: "month"}`). Line item uses **inline
  `price_data`** unless the offering's env override (`STRIPE_PRICE_COHORT`) names a
  dashboard-managed Price. `metadata.offering` tags the session for the thanks page and
  dashboard filtering. Errors: 503 when `STRIPE_SECRET_KEY` unset (buttons show a
  friendly "not configured" message), 400 bad JSON/unknown offering, 502 on Stripe
  failure. `success_url` = `/builders/thanks?session_id={CHECKOUT_SESSION_ID}`,
  `cancel_url` = `/builders?canceled=1`.
- **CSRF:** the route is state-changing, so `src/middleware.ts` adds `/api/checkout` to
  the module middleware's `protectedPrefixes` (same-origin Origin/Referer check).
- **No webhook (v1):** fulfillment is manual — receipts come from Stripe (per dashboard
  email settings), the roster is read off the dashboard. A `checkout.session.completed`
  webhook (e.g. notify adam@xl.net, seat counting for the 6-person cohort cap) is the
  known next step; the cap is currently enforced socially ("if the current cohort is
  full, you start with the next one" on the card), not technically.
- **Dependency:** `stripe` npm SDK (server-side only; no Stripe.js on the client).
- **Webinar recording:** `/builders` links a self-hosted copy of the May 21 Zoom
  webinar ("AI in the Workplace: Productivity Opportunities and Cybersecurity Risks",
  54 min, 136 MB) at `public/media/ai-in-the-workplace-webinar-2026-05.mp4`. The file
  is **gitignored** (`/public/media/*.mp4`) but ships to the VM anyway because
  deploy.sh rsyncs the working tree — like `data/GeoLite2-ASN.mmdb`, it must exist on
   `deploy/rsync-excludes.txt` (host-owned, appended to both exclude sets)
   excludes `.claude/worktrees`: concurrent agent sessions keep git worktrees
   INSIDE the repo and churn them mid-deploy; a worktree vanishing during the
   rsync aborted a deploy with exit 23 (2026-07-17).
  the dev box for a rebuild (source: the Zoom share link in the AI Builder launch
  email; the pwd-tokenized share URL → `share-info` → `play/info` API flow yields the
  `viewMp4Url`). Next serves it from `public/` with Range support (seekable playback).

### 5.11 AI-news blog (module §19, host-owned news seam)

Adopted 2026-07-12 (aicompany v1.0.4, since bumped to v1.2.1; needs brain ≥ v1.95, §7).
One post per night
about the most consequential AI story of the last 24h, authored end-to-end by the
module's blog engine and disclosed as AI on every article. The `blog` block in
`site.config.ts` configures it (`quality.posture: "publish"`,
`quality.contract.minQuestionHeadings: 0` — the default 2 forces question-form H2s,
which the news-first standard bans, `pointOfView:
"neutral-third"` — wire-style body; Tron's first person lives only in the styleGuide's
fenced "Tron's take" section (was "persona-first-person" until 2026-07-14: the global
first-person prompt line fought the fence and tanked voiceAdherence), `news`
`wordRange` [600, 1700] (1500→1700 on 2026-07-14: the news-first structure runs
~1600 on the same stories), `cadence` 7/week with `ramp: [7]`,
`yearStamping: false`, `refreshPerWeek: 0`). The `editorial` block encodes the
**news-first standard** (adopted 2026-07-14 after two external-standards reviews found
a post reading as op-ed in the news slot): dated attributed lede, inverted pyramid,
per-sentence source+date on every stat (year-flagged if >1y old), declarative headings,
no reader-directed imperatives in titles, quotes only for real attributed speech, all
persona opinion fenced into one closing "Tron's take" section (≤~25%) with a one-line
disclosure when the advice overlaps services XL.net sells; `bannedPhrases` additionally
scrubs pipeline-residue phrases ("the fact sheet", "the source material", …) via the
module's mechanical contract-gate scrub. The standard's enforceable form is the
**16-item template checklist** in `src/lib/blog/editorial-checklist.ts`
(`NEWS_ARTICLE_CHECKLIST`, adopted 2026-07-14 from a second round of process+archive
reviews), appended to `editorial.styleGuide` so it rides in both the writer prompt and
the rubric's voiceAdherence scoring: source floor + independence, primary-first citing,
**every source hyperlinked at first mention using its fact-sheet "Cite as" URL verbatim**
(the archive had ZERO external links while the disclosure promised them), no invented
URLs, normalized "Month D, YYYY" dates, >1y age flags, single-source hedging for
extraordinary claims, headline/lede/TL;DR/heading form, quote + statistic integrity,
attribution grammar (full at first mention then short form), opinion fence, COI line,
dated editor's notes on republished articles, and any in-article mention of the
methodology written as the markdown link `[methodology](/methodology)` (never a bare
path — the 07-14 editor's notes shipped "see /methodology" as plain text). A
reader-facing summary lives at `/methodology`. All rendering, gates, admin, RSS,
sitemap, and the nightly job itself live in `@aicompany/core` — the host owns only:

- **The news seam** (`src/lib/blog/news.ts` + `scripts/fetch-ai-news.mjs`). The
  module picks a topic *before* `dataSource.getContext` runs (calendar → strategist,
  neither sees live data), so today's news is injected two ways, both fed by
  `scripts/fetch-ai-news.mjs` (plain-Node ESM; **two** Tavily `POST /search` calls
  `topic:"news", days:1` — the fixed general query plus one of four rotating beat
  queries (model releases / regulation / security incidents / enterprise adoption,
  day-of-year modulo; single-query top-result-wins produced five straight
  governance-anxiety stories), merged by URL keeping the higher score; drops results
  whose cleaned **title** has no AI term — a generic outlet page outscored every AI
  headline and got published 2026-07-14; zero relevant results = exit 1, same
  stale-file degradation as a failed fetch; writes `data/ai-news-today.json`
  atomically). 2026-07-22 (peg steering): survivors are re-ranked by
  `scripts/lib/peg-score.mjs` — `(pegScore desc, Tavily score desc)` — before the
  top pick and the headlines array are written. `pegScore(title, {publishedAt})`
  is a pure additive heuristic: +2 named actor (known org/regulator list, or a
  mid-title Capitalized token with the sentence-initial word and an
  AI/GPT-style stoplist excluded), +2 dated-event verb
  (launches/releases/sues/fines/orders/… — "reveals"/"finds" deliberately
  absent), +1 number in title, +1 published <48 h; −2 per peg-less signature
  (survey/poll, "study finds…", "N% of leaders…", leading Why/What/How,
  question-mark title, opinion/commentary, "the state of"); a fresh NAMED
  survey release gets a one-time +2 offset (its release IS the peg).
  **Demotion, never exclusion** — a peg-less day still leads with its best
  story; every score and any top-story change is logged to stderr. The file
  gains `top.peg {score, pegless}` and `headlines[].pegScore` (news.ts is
  tolerant of old files without them). Tests: `npm run test:peg`
  (`scripts/peg-score-tests.mjs`, pins the 2026-07-22 survey headline as
  negative and the named-release offset). `newsCalendarEntries()` turns
  the top story into a **one-entry `topics.calendar`** (slug carries the date, so a
  consumed entry never blocks the next day; a fresh calendar slug is always chosen
  before the strategist and still passes the full topic gate); when
  `top.peg.pegless` it appends the report-of-record framing sentence to the
  entry description (the writer's "Brief:") — the lede must name the
  publishing organization and release date, reporting the findings, not
  editorializing the trend (the wording is neutral on purpose: the
  description flows into `checkTopic`'s offLimits haystack, safe today
  because `offLimits: []` — pinned by test:peg). `newsSeedHints()` gives
  the strategist today's other headlines as the fallback when the calendar entry is
  dedup-rejected, pegged-first, with peg-less hints annotated
  `[no dated news peg — usable only framed as a report-of-record …]`. `newsDataProvider.getContext()` then searches Tavily live for the
  chosen story (`include_raw_content`) and builds the factSheet (`statCapacity` from
  numeric-token count clamps the named-stats gate honestly); each source body is
  capped at ~2,500 chars **at a sentence boundary** (word-boundary fallback) — a hard
  mid-word slice here fed the fact-check gate truncated facts and noindexed the
  2026-07-12 article; a provider throw is the module's sanctioned WARN-skip. Each
  source section (2026-07-14) carries `Published:` normalized to "Month D, YYYY"
  (raw feed dates like "Thu, 18 Jun 2026 09:10:07 GMT" were being published verbatim
  in article copy), a `(NOTE: more than a year old …)` flag past 365 days, and a
  `Cite as: [hostname](url)` line the checklist's link rules key off.
- **The prefetch trigger.** The blog systemd unit has no `ExecStartPre` hook, so
  `news.ts` runs `fetch-ai-news.mjs` via `execFileSync` at module load **only** when
  `process.argv[1]` ends with `blog-nightly.ts` and the file is missing/stale >20h —
  covering both the timer and admin Run-now, inert everywhere else. Because
  `site.config.ts` is imported by the **Edge middleware**, `news.ts` detects the Edge
  Runtime (`globalThis.EdgeRuntime`) and touches no node builtins there (blog steering
  returns empty/defaults; the middleware has no use for topics). Under Node it loads
  fs/path/child_process via `process.getBuiltinModule` (≥20.16) so the bundler never
  follows a top-level `import "node:fs"`.
- **Wrapper mounts** (all 2–4-line, README §2.1): `src/app/blog/{page,[slug]/page}.tsx`,
  `src/app/rss.xml/route.ts`, `src/app/admin/blog/page.tsx`, `src/app/api/admin/blog/
  {route,run-now/route,action/route}.ts`, and `blogSitemapEntries` spread into
  `src/app/sitemap.ts`. Nav/footer "AI News" links in `layout.tsx`. `admin.enabledPages`
  gains `"blog"`.
- **Persona interplay** (module §19.9, defaults on): each published article writes one
  `brain_memories` row `source_type='blog_article'` (§5.9 allowlist), and the article
  index is appended to Tron's prompt doc so he can cite recent posts in chat.

The nightly job (`packages/aicompany/scripts/blog-nightly.ts`, tsx) preflights the brain,
takes a pg advisory lock, budgets against the ramp, authors → runs deterministic +
LLM fact-check + 6-dim rubric gates → applies posture in one DB transaction, writes the
`data/blog-last-run` heartbeat on every exit path, and emails a per-run report
(`[aiwebsite] OK|WARN|FAILED blog: …`) to `oversight.alertEmail`. Under `posture:
"publish"`, an article that fails or skips its LLM gates still publishes but is
`noindex`ed and excluded from the sitemap/RSS until a later clean gate pass — so
crawlers never see unchecked copy while the decision to publish is honored. `methodologyUrl`
is intentionally unset (accepted config:check WARN — no methodology page yet).

v1.1.x/v1.2.1 posture (module MIGRATIONS.md is canonical): this host adopts **none** of the
v1.1.0 optional features (no `measure`/GSC, no `cta.funnelEvents`, no `topics.adminQueue`,
no methodology page, no `llms-full.txt`, no publish webhook) — so no feature tables beyond
the mandatory `blog_posts` prune columns (§6). Default-on v1.1.0 behaviors accepted as-is:
the monthly digest email (`reports.monthlyDigest`, §9.7 timer), prune **flag** lines in the
run report (default `action:"flag"`; a flag run forces outcome ≥ WARN), and the orphan-audit
report line. v1.1.1 adds the deterministic prompt-leak/fix-artifact scrub sets to Gate 1
(a match publishes noindexed until a clean pass). v1.2.1 bakes `dataSource.autoLinkTerms` +
`linking.autoLink` into the stored ArticleDoc at write time and scopes Gate 1's
dead-internal-link check to the blog `urlPrefix`es. v1.2.2 (adopted 2026-07-13, no host
action) fixes the gate prompts that made the 2026-07-12 posts oscillate: fact-check treats
markdown links as navigation (not claims) and keeps the v1.0.4 attributed-opinion carve-out
(absent from the v1.2.1/v1.3.0 tags — release-line regression); the writer aims 70% into
`wordRange` with the max as a hard ceiling; refresh retries restate the still-binding
contract next to the quoted violations; the strategist may not propose trend theses no
source states; v1.2.3 scopes the belief contraPositions check to ENDORSEMENTS (rebuttals of a contra position were being flagged). Host-side companion: `news` `wordRange` cap 1400 → 1500 (the writer
consistently lands ~1425–1450 on busy news days; trimming triggered the oscillation).
**v1.3.0 (adopted 2026-07-13): nightly hero images via the module adapter** (module §19.26)
— `blog.heroImage: createGeminiHeroGenerator(...)` in site.config.ts (futurism palette,
news-topic subject motifs, `GOOGLE_GEMINI_API_KEY` from the host env — this host's
canonical Gemini var, same one the brain planner reads; the initial wiring read
`GEMINI_API_KEY`, which was never in this host's env, and the first backfill ran
image-less until fixed 2026-07-13; no new module env var),
default DB storage in the composed `blog_hero_images` table (§6, migration `0008`),
served by the `app/blog/hero/[slug]/route.ts` wrapper (immutable cache + ETag,
`blog_hero:<ip>` 240/60s limit, malformed slug ⇒ 400 so doctor can probe the mount).
Failures degrade to an image-less publish (§19.7) recorded in the run report;
`ogImageFallback` covers pre-v1.3.0 posts. `sharp` became a direct dependency (it was
resolved only through Next's optionalDependencies — module panel finding). Existing
posts get heroes via `tsx packages/aicompany/cli/backfill-heroes.ts` (operator step).

### 5.12 AI Governance builder (host-owned)

Shipped 2026-07-16 after a five-expert planning panel + five-critic review (the §14
protocol). Signed-in users draft AI governance documents WITH Tron Netter at
`/governance`: a single **AI Acceptable Use Policy (AUP)** (employee-facing: what is OK to share,
approved tools, incident reporting) or a **working draft set of core documents** for
NIST AI RMF (7 docs), the EU AI Act (10 docs), or ISO/IEC 42001 (10 docs). Tron
researches the user's company first (their site + web mentions + industry), then asks
one question at a time; each answer live-edits the on-screen draft. When the host-owned
question bank is covered, the UI flips (cyan → sand, four simultaneous signals) to a
review/confirm state. Word-friendly downloads (single `.docx` or `.zip` of `.docx` +
README) are available in every state; projects hard-delete 30 days after last activity.
Everything is host-owned (`src/lib/governance/`, `src/components/governance/`,
`src/app/api/governance/`, `scripts/governance-*.ts`) — no submodule changes.

**Naming (round 18, 2026-07-20):** the single-document offering was renamed from
"AI Usage Policy" to **"AI Acceptable Use Policy (AUP)"** (industry term of art;
3-expert + 3-critic panel). Two-tier convention: the parenthetical "(AUP)" appears on
offering/marketing surfaces (`KIND_LABELS.usage_policy.name`, /work exhibit, ZIP
README header); the bare formal title "AI Acceptable Use Policy" is the blueprint/doc
title (letterhead, model-facing prompts — no acronym in model-facing text); flowing
prose uses lowercase, and SEO copy keeps "AI usage policy" once as a searched
secondary phrase. The DB kind value `usage_policy` and doc slug `ai-usage-policy` are
STORED IDENTITY (project rows, `documents_json`, op allowlist, feeds,
`placeholderSectionMap`) and are permanently retained. Blueprint placeholder strings
are byte-frozen (exact-match drafted detection fails open if edited), so the one
"usage policy" mention in the genai-profile-addendum placeholder intentionally keeps
the old phrasing. Existing projects keep their stored "AI Usage Policy" doc title;
because `retitle_doc` is ungated and the system prompt now names the new title, the
model may converge old projects' titles to the new name on ordinary user-initiated
turns — accepted. Download filenames derive from the STORED doc title
(`docFileNames()` in docx.ts: `fileSlug(title, slug)` + collision dedupe, used by the
zip, its README listing, and the single-`.docx` content-disposition), so old projects
keep `ai-usage-policy.docx` and new ones get `ai-acceptable-use-policy.docx`. The
standards-refresh script gained `--reseed` (regenerate `cross-standard-digest.md` +
re-upsert seed memories from current templates, skipping deploy-marker/research
gates) — run once on the VM post-deploy, since digest/seed wording otherwise only
refreshes on a quarterly or watch-triggered research run.

**FFIEC bank offering (round 20, 2026-07-21, 4-expert + 4-critic panel):** a fifth
kind **`ffiec_aup`** ("Bank AI Acceptable Use Policy (FFIEC)", badge "FOR BANKS ·
POLICY + AMENDMENTS", second card in `GOVERNANCE_KINDS`) ships a hub-and-spoke set
of 7 docs: Board hub `bank-ai-use-policy` (10 sections, drafted ALONE at turn zero),
five amendment docs (`amend-model-risk`, `amend-third-party`, `amend-infosec`,
`amend-compliance`, `amend-bsa-aml`; each `landing` + 3 content sections;
cross-reference-never-restate is a hard prompt rule, and a bank reporting no target
policy gets that doc redrafted as a starter policy and retitled via the ordinary
`retitle_doc` op), plus `ai-artifacts` (5 management-owned template sections).
FF-01..FF-15 bank (FF-01 snapshot, FF-15 optional exam-posture, CSI warning in its
why). Blueprint strings carry NO numbered supervisory identifiers (SR/circular
numbers live only in the weekly-refreshed `data/governance-standards/ffiec-ai.md`
and its `standards.ts` FALLBACK). Proportionality: `src/lib/governance/lbr.ts`
downloads/caches the Fed's quarterly Large Commercial Banks release
(`data/lbr/lrg_bnk_lst.txt` + `meta.json`, tmp+rename; refresh timer is writer of
record weekly via `LBR_REFRESH_DAYS`, research script bootstraps an absent cache;
two idempotent writers by documented design), parses the fixed-width two-line
records linearly, matches conservatively (bidirectional distinctive-token match;
ambiguity = no match; city/state corroboration for high confidence), decodes only
NAT/SMB/NMB charters (wrong regulator is the unrecoverable error), and maps
`assetTier` under-1b|1b-10b|10b-30b|over-30b == the FF-02 chip partition.
`bank_profile_json` (migration 0017, cold column, lenient-parsed) carries
`{detectedAt, evidence[], decision, lbr, tier}`; `buildSystemMessage` gains
`ffiecBlock()` (FFIEC drafting rules + tier calibration + extended
never-claim-endorsement list) for this kind only — all other kinds' prompts are
byte-identical (pinned). FF-02's stored question stays static; `view.ts
hydrateAssetSuggestions` prepends the found-figure chip at read time, and the
answer turn writes the tier back deterministically (`tierFromAnswer` in
`applyTurnWrite`'s fenced statement). **Bank detection + switch:**
`bank-detect.ts detectBankSignal` runs host-side (zero AI/Tavily) in the research
script at the brief-final join for non-FFIEC projects with no recorded decision:
two-independent-keyword-class gate (institution AND regulator terms,
partner-bank-attribution exclusion) OR high-confidence LBR match + one class; on
fire the run PAUSES pre-turn-zero via `pauseForBankCheck` (new status
**`bank_check`**, single fenced write mirroring handoff, checkpoints kept but
progress hidden by the view, reaper/kick/claim all blind to the status) storing a
`qs_<rev>` switch card (`isSwitchId`; NOT matched by `isQuestionEntry`, so it never
consumes a question number). The answer route resolves it synchronously before
every gate (chase-skip precedent): exact chips only (`parseSwitchDecision`;
anything else 400s and re-presents), skip = continue; `applyBankCheckDecision`
applies the pure `applyBankSwitch` reducer in one rev-fenced statement (switch:
kind flip + re-scaffold + accumulator reset — provably nothing user-produced exists
pre-turn-zero; both: decision recorded forever, qs_ transcript row, status
`queued`) then `kickResearch`. The research script resumes a decided row from its
OWN stored brief through the existing reuse machinery (continue = same-kind,
straight to turn zero; switch = ffiec probe top-up + LBR lookup first). Turn-zero
grouping is now the exported `turnZeroGroups` partition in turn.ts (AUP one group,
ffiec hub alone then pairs, standards pairs — pinned for all five kinds).
Workspace renders `bank_check` as a standalone centered card
(`bank-check-screen.tsx`; STATUS_META word "Question", sand; no Stop — nothing
runs). ZIP README gains an FFIEC read-order/adoption map. Accepted limitations:
detection is deliberately conservative (banks/thrifts only — credit unions pick
the card directly; sub-threshold signals never pause) and per-project (a new
project on the same domain re-asks).

**Routes** (all `readSession`-gated; owner + 30-day retention filter folded into every
row fetch; missing/expired/not-owned are one identical 404 — no existence oracle; error
bodies `{error:{code,message}}`; CSRF via the middleware prefix):

| Route | Behavior |
|---|---|
| `GET/POST /api/governance/projects` | list (+ bounded global sweep of expired rows, any owner) / create — requires `{kind, domain?, ack:true}` (acknowledgment checkbox is recorded as `acknowledged_at`); consumer sign-in domains (gmail etc.) force manual domain entry; caps: 3 active, 5 creates/day (SQL-counted, restart-proof). Create auto-kicks research or parks `queued` |
| `GET/DELETE /api/governance/projects/[id]` | poll target (never mutates; reports `reclaimable` so the CLIENT re-POSTs research, and `turn` — the async answer-turn state derived read-only from the `turn_*` columns: `{phase:"running"}` while the claim is fresh, `{phase:"failed", error}` from a recorded failure OR a stale orphaned claim presented as a transport failure with resend copy; 60/min limit fits the 3 s flight-tab turn poll) / immediate hard delete |
| `POST .../research` | claim + spawn the detached research job; `{mode:"partial"}` = "start the questions anyway" after a failure (gap-flagged brief, straight to drafting). Claim is ONE conditional UPDATE enforcing owner, claimable status (created/queued/failed/stale-heartbeat >5 min), 3-runs/day, and the ≤2 global concurrency cap atomically (subquery count — no TOCTOU). A park replies 202 `{status:"queued", reason}` with `reason: "budget"\|"deploy"\|"disabled"` (`QueuedReason`, kick order kill switch → deploy marker → Tavily budget); the CLIENT keeps the last POST's reason in state (never persisted — the once-per-load reclaim re-POST refreshes it within a poll cycle) and the queued panel renders reason-specific copy instead of the merged budget-or-deploy guess, with `view.featureDisabled` outranking a stale parked reason and disabling the retry button |
| `POST .../answer` | one **asynchronous** Q&A turn (also review-phase revisions via `questionId:"revise"`; async because Cloudflare cuts proxied responses at ~100 s, which heavy turns exceeded). New clients send `mode:"async"`: synchronous preflights (validation → `stale_question`/`answer_cap` → fresh-claim dedupe → deploy-marker + brain `/health` gates as retriable 503 → DB-backed daily budget spend) → **atomic turn claim** (ONE conditional UPDATE on the row's `turn_*` columns keyed on owner+retention+status∈{drafting,review}+`rev`, claimable = no record / failed record / running claim older than `turnStaleMs` 240 s, which is also the lazy reap) → **202** `{pending, rev, promptId, questionId, startedAt}` → in-process worker via Next `after()` (`turn-runner.ts`): JSON-mode turn (full 90 s) → parse ladder (fence strip → lenient parse → ≤1 repair call with a NEW promptId, 60 s) → server-validated ops → ONE conditional write keyed on `rev` AND the claim's `turn_attempt_id` fence nonce (promptId is reused across user retries so it cannot fence; a reaped zombie writes nothing), clearing the claim; every failure records `{error}` in `turn_json` and releases the claim (`turn_started_at` NULL = instantly reclaimable). The GET poll resolves the outcome. Duplicate POST same promptId while running → 202 replay (no spawn/spend); different promptId → 409 `turn_pending`. `mode:"async"` is REQUIRED (version negotiation): a markerless POST is a stale pre-async client that would spread the 202 body into its view, so it gets a reload-this-page 409 `invalid_request` instead (the legacy synchronous driver was deleted one deploy after the async cutover; the CLIENT keeps its sync-apply branch as mid-deploy defense). 6/min/user, 40 answers/project (the 40th force-flips to review), answers ≤2000 chars, `questionId` mismatch → 409 `stale_question` (dual-tab guard). Revise turns accept optional `focusSections: string[]` (`"slug#section"`, ≤20, shape-checked at accept, validated against the docs in the worker, bogus refs silently dropped) — the open-item resolver sends the sections its batch targets so `serializeDraft` includes them VERBATIM (the model cannot edit an elided section it sees 120 chars of). Two further reserved ids run **non-advancing turns** (2026-07-17; legal in drafting AND review, skip the stale-question and answer-cap checks, `answersIncrement 0`, coverage untouched, status/question/summary preserved via `resolveNonAdvancingGate`): `questionId:"restyle"` (format pass — requires an attached style sample and ≥1 `focusSections`, empty answer allowed, own rate bucket `gov:restyle` 8/min, accept-time batch-size check against `turnOpMarkdownTargetChars`; optional body flag `restyleFinal: true` marks the run's last batch (round 16) — the worker's success write then clears the `style_sample_debt` token it fetched pre-claim (token-equality CASE inside `applyTurnWrite`; client-asserted and owner-only, a forged flag clears the owner's own cosmetic debt line and nothing else); a validated response with zero applicable ops lands as a no-change SUCCESS pass (rev bump, claim clear, debt clear when final) instead of `invalid_turn`; the worker re-derives the safe target set itself — placeholder and stub sections NEVER restyle, or a reworded scaffold would launder undrafted text past the confirm gate — op-filters the response to `upsert_section` ops inside the batch plus at most one `reorder_sections` op per batch doc plus (round 18b) at most one `adopt_outline` op per non-stub batch doc (EXACT partition of the doc's current section ids into sample-titled buckets, enforced in applyOps: drop/dupe/invent = whole-op reject; stored as documents_json outline, presentation-only, zero sections marked changed) (round 14b structure adoption: `order` must be an exact permutation of the doc's current section ids — applyOps rejects anything else whole, so a reorder can never drop, invent, or duplicate a section; ids are stable so feeds/placeholders/open items survive, and host numbering renumbers on render), and hard-gates marker preservation per touched section: lenient count AND `findConfirmMarkers` excerpt-sequence equality, violation = failTurn, nothing written; transcript row `qId:"restyle"`), and `questionId:"amend"` (correct an earlier answer — body adds `amendIndex` into the append-only transcript, target must be a `q_`/`qi_` row, non-empty answer; the worker focuses on the original entry's stored `feeds` (bank feeds for legacy rows), the prompt carries original Q + old A + corrected A, review amends inherit the revise marker rules and refresh the summary through `withOpenItemsNote`; transcript row `qId:"amend"` with `amendsIndex` + `feeds`; a stored `qi_` chase question is always re-picked after a non-advancing turn since its text quotes one specific marker excerpt) |
| `POST .../confirm` | review → done (only from review). **NOT gated on `governanceEnabled`** (zero-AI status flip; since reopen exists, gating it would strand a reopened project as a watermarked draft while the switch is off). Rate bucket is per-project (`gov:confirm:<user>:<id>` 20/day) so reopen/confirm cycles on one project cannot lock the user out of finalizing another. Refuses (409 `turn_pending`) while a fresh revise-turn claim is running — the worker's apply must not race the done flip (both the route precheck and the `confirmProject` WHERE enforce it; stale orphaned claims don't block). **Refuses (409) while any non-stub section still holds untouched blueprint scaffold text** (host-computed `placeholderSectionMap`, exact-match, fail-open on a corrupt column so confirm can never brick; stub docs excluded — their pending/determined state keys on the presence of a `determination` section instead), **and refuses (409 `open_items`) while ANY `[TO CONFIRM]` marker remains** (owner ruling 2026-07-16: a FINAL carries zero markers, each resolved by the user, never silently accepted; the gate count is the LENIENT scan `countConfirmMarkers` — every `/\[TO\s*CONFIRM/gi` opener — so a malformed marker the item parser cannot display still blocks). The client intercepts first with an info notice (button stays enabled); the 409 is the stale-tab backstop |
| `POST .../resolve-item` | keep ONE open `[TO CONFIRM]` item as drafted (body `{doc, section, excerpt ≤200, occurrence}`): deterministic host-side strip (`stripConfirmMarker` in markdown.ts) with residue cleanup (seam spaces, space-before-punctuation, empty paren/bracket husks) — ZERO AI calls, works through brain outages and budget caps; gated on `governanceEnabled` like every mutation. Legal in TWO phases (owner fix 2026-07-17, the "as is" chase loop): **review** (the resolver cards, unchanged behavior) and **drafting while a `qi_` chase question is stored** (any other drafting state → 409 `invalid_request`). A drafting keep additionally validates the addressed marker IS the one the stored question asked about (`feeds[0]` must equal `doc#section` AND the `(excerpt, occurrence)` must match the section's first STRICT-parse marker via `scanConfirmMarkersWithPos()[0]` — the strict first, never the lenient first, since `pickOpenItemQuestion` quotes `findConfirmMarkers()[0]` and a malformed opener can precede it; mismatch → 409 `item_not_found`), then in the SAME fenced write re-picks the next chase question (`pickOpenItemQuestion` over the post-strip docs — never null while the lenient total is positive) or, when the strip cleared the LAST marker, flips to review with host copy `REVIEW_RESOLVED_SUMMARY` (a stored `qi_` question implies bank coverage is complete, so nothing is left to ask). 409 `turn_pending` while a fresh turn claim is running (phase-specific copy; a strip bumping `rev` under the worker would void its final write and waste the brain call; the write's WHERE enforces the same horizon atomically — `applyResolveWrite` in db.ts: rev + owner + expected-status + no-fresh-claim fence, claimless so it never touches the `turn_*` columns; the drafting arm passes an `advance` block that writes status/nextQuestion/reviewSummary through the same UPDATE). 409 `needs_answer` when the strip would empty the containing paragraph / list item / table cell (the marker IS the content there; the view's `confirmable:false` computes the same predicate). 409 `item_not_found` when already resolved (other tab) or the `rev` fence lost. Transcript: review keeps append the unnumbered `qId:"confirm"` entry as before; a drafting keep appends the REAL Q&A pair (`qId` = the stored `qi_` id, question text verbatim, answer "Kept as drafted.") so the monotone question counter advances honestly and the row is amendable later; `answersCount` unchanged in both (keeps are free and bounded by marker count). Own rate bucket 30/min/user. Returns the turn-response shape (the drafting arm with truthful `status`/`nextQuestion`/`reviewSummary`) |
| `POST/DELETE .../style-sample` | optional sample-policy upload (multipart, one `.docx`/`.pdf`/`.md`/`.txt` ≤2 MB): only extracted plain text is stored (never the file; docx via a linear-time jszip extractor: streaming decompression-bomb cap, headings/lists/table rows preserved, prompt-fence tokens stripped, and REAL auto-numbering reconstructed (round 15d, `docx-numbering.ts`): word/numbering.xml + word/styles.xml inflate under a 2 MB aux cap (overflow/absence only disables enrichment, never the upload), paragraph numbering resolves direct numPr (pPrChange-guarded so tracked-change numbering never advances counters) or style-chain numPr with the ECMA-376 w:lvl/w:pStyle back-reference outranking a style's own ilvl, counters key on abstractNumId (shared abstracts continue, startOverride re-bases on a numId's first fire, unfired levels render their effective start), every numeric attr parse-and-clamped 0..9999, letter/roman formatting O(log n), lvlText %-tokens render each referenced level in its own numFmt (isLgl forces others decimal), numFmt bullet/none map to dash/plain, and model-null output is byte-identical to the pre-15d extractor; pdf via pdfjs-dist getTextContent with POSITIONAL line assembly (round 19, `assemblePdfLines`): Word-exported PDFs emit list/heading auto-number labels out of reading order, so positioned items may merge into one of the last 12 lines when |dy| <= max(2, 0.45x max(h, first-member h)) and splice by x (gap > 0.3x font height inserts a space; bullet glyphs normalize to "- "; Symbol-font PUA dropped; rotated/transform-less items keep stream-order append; RTL lines never x-splice; multi-column degrades to stream order via the recency window; 30k items/page truncation), then `shapePdfListLines` (post-frame-strip, never across pages) ranks marker-line startX clusters (9pt quantized) into <=2 indent tiers, joins wrapped continuations into their item line (within 3pt of the marker's text x, gated on the item not already ending a sentence OR the continuation starting lowercase) and drops residual bare "N." label lines so the sample never teaches the orphan-number shape; no rendering, 40-page cap, 10 s deadline that destroys the parse task, dedicated scanned-PDF copy, headings inferred from font height AND from getOutline() bookmarks (round 15d: normalized number-stripped title matching upgrades extracted lines to the bookmark's depth, unmatched titles dropped - never synthesized; struct-tree/MCID correlation and font-bold detection deliberately NOT read: fonts never resolve into commonObjs under a getTextContent-only workflow, verified against pdfjs 6.1.200 sources) (round 14b: lines >=1.2x/1.5x the document-median size, short and non-sentence-shaped, become ##/# so a PDF template's structure reaches the prompt; <8 lines = no inference) plus BOTH glued-number recoveries: trailing "Purpose1." chains (round 18b) and, post-positional-assembly, leading "1. Purpose" chains (round 19, `recoverLeadingNumberedHeadings`: ascending +1 from 1, >=3 links, title-shaped, tier-0 only, ":"-terminal lines excluded as list parents; round 19b made the indented-marker-child signal CHAIN-LEVEL - each link records whether its next non-blank line is an indented marker, and only a strict majority of such links vetoes the whole chain (tie promotes): the per-link skip was undecidable line-locally and broke the chain on ISO-template samples whose Definitions/Policy sections open with sub-lists; col-0 siblings are deliberately NOT list evidence (numbered body paragraphs and bare skeleton templates must promote), and the accepted, test-pinned limitation is that a flat col-0 checklist of short title-shaped lines in an otherwise outline-dead document still promotes). Because extraction runs once and the file is discarded, rows stored under pre-fix extractors are healed at READ time (round 19b, `healSampleHeadings`): every consumer of `style_sample_text` (turn-runner's row shadow covering all turn prompts and the applyOps bucket-title allowlist, the view's numbering/outlineTitles/verbosity, the download route's numbering, and turn zero in `scripts/governance-research.ts`) reads through this pure, linear, idempotent function, which re-runs both numbered-heading recoveries in pipeline order ONLY when the stored text has fewer than two sampleOutline-shaped heading lines (the exact disarmed state) AND the stored filename is not .docx/.md/.txt (the recoveries only ever ran in the PDF branch); the healed text is never written back - the stored row stays the only copy of data derived from a discarded upload; pdfjs-dist MUST stay in next.config `serverExternalPackages` or the bundled build throws on every PDF), injection-screened, ≤20k chars on the row, deleted with the row. Every drafting turn then mirrors the sample's formatting AND structural conventions (topic flow, intra-section organization, title terminology) EXCLUDING numbering, which is host-owned (a ≤6k-char slice rides the system prompt fenced as DATA, plus a SAMPLE OUTLINE digest of the WHOLE stored sample's heading lines, ≤60 lines level-indented, so the full outline is visible past the slice; rules win on conflict). The sample's section-numbering STYLE is detected (`detectNumberingStyle`, round 15b) and adopted by the HOST renderers (doc pane + docx; derived at view/download time, never stored). A successful upload AUTO-STARTS a whole-draft reformat run in the workspace (client-chained `questionId:"restyle"` turns, see the answer row and §5.12 round 13d — queued while a turn is in flight, skippable, latched Stop); the server itself only stores the sample. POST also writes the reformat-debt nonce (round 16): a fresh `newId("govd")` into `style_sample_debt` when `uploadCreatesDebt` (status drafting/review AND ≥1 non-placeholder drafted section), else NULL — an upload with nothing drafted clears stale debt; DELETE always clears it (no sample, nothing to match). The view exposes the file NAME plus `reformatDebt` boolean, the stored `letterhead` strings (for the control's preview) and a derived `verbosity` {band, targetWords} (never the debt token or sample text). ROUND 17b letterhead capture (`letterhead.ts`): for `.docx`, the body sectPr's default-referenced header/footer parts (LAST sectPr wins; default > first > even, resolved through word/_rels/document.xml.rels, traversal targets rejected) are extracted with a linear field-aware walk: complex (fldChar begin/separate/end + instrText) and simple (fldSimple w:instr) PAGE/NUMPAGES fields become {{PAGE}}/{{PAGES}} tokens with their cached digits SUPPRESSED, other fields keep their cached display text, literally typed "Page N of M" tokenizes too, document-control lines (version/revision/effective/approved/review/date) are DROPPED (a mirrored approval line fabricates review history - UPL posture), company/address/classification lines pass verbatim, and a line matching the sample's own title (its first extracted heading, case/whitespace-insensitive substring) swaps that span for a {{TITLE}} token so every generated document renders its OWN title. Caps 4 lines/200 chars-line/480 chars-part; stored in `style_sample_header`/`style_sample_footer` (migration 0016): empty string = scanned-nothing-found (image-only letterhead, the UI says so honestly), NULL = pre-round-17 sample (UI offers re-upload) or non-docx upload. PDF page-edge lines that repeat are BOTH stripped from the stored body (letterhead x40 pages would pollute the prompt slice and bias the verbosity metric) AND, since round 17c (owner parity ruling 2026-07-20, overriding the 17b panel's strip-only stance), adopted into downloads through the SAME shaping pipeline as .docx parts (tokenize, control-line drop, title substitution). Thresholds: >=2 pages; 2-3 page docs require the line on EVERY page, 4+ pages >=70 percent (min 3); 1-page docs can never prove a frame (honest empty-state copy). False-positive guard `frameCandidateKey`: digit-free lines match case/space-insensitively, page-number-bearing lines (tokenizable, <=80 chars, no terminal punctuation) match digit-insensitively, ANY other digit-bearing line must repeat exactly - a per-page "Section N" heading or a body sentence citing "page N" must never print on every export page (both shapes caught live by the round-17c e2e, now test-pinned). Letterhead text NEVER rides any prompt (render-only, like host numbering). Locked once `done`; DELETE works in any status and clears the letterhead columns |
| `POST .../reopen` | done → review (owner request 2026-07-17; the one inverse of confirm). ZERO AI calls; content untouched. Returns the project to review, where amend/revise/resolver/restyle are already legal and already gated, and downloads carry the DRAFT watermark again until the user re-confirms through the same gates (an amend can reintroduce `[TO CONFIRM]` markers, and only the review machinery can force them back to zero). `reopenProject` (db.ts) is fenced on owner+`status='done'`+`rev`+retention and, UNLIKE confirm, **bumps `rev` and clears all four `turn_*` columns**: a done row can carry a stale claim or failed-turn record (confirm clears nothing), and appending to the transcript without a rev bump would leave a stale-but-alive worker's rev+attempt fence matching (`applyTurnWrite` additionally refuses status∉{drafting,review} as a belt-and-suspenders guard on the confirm-then-zombie race). Also clears `changed_sections_json` (no resurrected Updated chips beside "the text stays exactly as it is" copy) and writes the host `REVIEW_REOPENED_SUMMARY`. Appends a `qId:"reopen"` transcript row ("Reopened for changes" — numberless audit entry, listed in the transcript, included in the "and revisions" label predicate). Gated on `governanceEnabled` (reopening into a workbench where every tool 503s is a trap). Rate bucket `gov:reopen:<user>:<id>` 20/day. 409 `invalid_request` unless status is done. Client: "Reopen for changes" button on the final panel; no optimistic flip — it refetches and the workspace's done→review branch announces "Reopened. The draft is back in review." and focuses the review heading (the review panel shows "Back in review" whenever the transcript holds a reopen row, which is sound permanently: review is only re-enterable via reopen). Final-ZIP README no longer embeds `review_summary` (draft READMEs only): since reopen it can contain review-workbench guidance that has no place in a final deliverable |
| `GET .../download` | `?format=docx&doc=<slug>` or `?format=zip`; generated on demand from stored markdown, streamed, never stored, ZERO AI calls (works through every outage/cap and the kill switch); DRAFT watermark + `-draft` filename until done (a REOPENED project is not done, so its downloads re-watermark automatically); touches `last_activity_at` (disclosed). Round 17b: the stored sample letterhead renders as REAL Word page headers/footers on every generated .docx (docx npm Header/Footer): {{PAGE}}/{{PAGES}} tokens become live PageNumber fields, {{TITLE}} becomes each document's own title, tab-separated segments get center (4513) + right (9026 twip) tab stops; drafts add a per-page amber DRAFT run to an adopted header (page 1's watermark never reaches page 3 of a printout), and whenever ANY letterhead renders the footer appends a renderer-owned provenance line (`PAGE_PROVENANCE_DRAFT` "AI-generated draft. Not legal advice." / `PAGE_PROVENANCE_FINAL` "AI-generated. Not legal advice; review by counsel required before adoption." - never stored, so sample lines cannot displace it, and a confirmed final never calls itself a draft). No letterhead = byte-identical pre-17 output (no header/footer parts at all) |

Every question (`NextQuestion`) carries `feeds: string[]` — the `"<doc-slug>#<section-id>"`
pairs its answer updates (bank questions from `blueprints.ts`; model follow-ups via their
`bankId`; legacy rows normalize to `[]`). The workspace uses it to anchor the interview to
the draft: fed sections get a dashed "Asking about this" marker (distinct from the solid
cyan UPDATED treatment), the doc pane auto-scrolls its own container to the first fed
section when a question arrives (guarded: cancelled by user scroll/answer/status change;
container-scoped so the page never moves), and the question card carries a "See the text
this is about" jump link for the mobile Questions tab.

**Stale-bundle detection (round 13e).** A /governance tab is an SPA with a poll
loop; it runs its deploy-time bundle forever. The npm `build` script stamps
`NEXT_PUBLIC_BUILD_ID=$(date +%s)` (package.json; ONE shell evaluation per build,
so every build worker inlines the same value into client AND server bundles, and
the watchdog's bare `npm run build` restamps — the reason this is NOT a deploy-
script .env stamp). `src/lib/governance/build-id.ts` exports the inlined BUILD_ID
plus the pure `staleBundleSignal(clientId, serverId, consecutive)`: fires only
when both parse as positive ints (dev/next-dev disable), server NEWER (ordered,
so a draining old pm2 worker answering one poll never fires), and delta >= 120s
or 2 consecutive sightings. ProjectView carries `serverBuildId` (additive);
the workspace counts mismatches in handleView (skipped mid-flight), latches
once, logs `[gov-stale] ...`, and renders a dismissible panel in the existing
page-condition slot ("This page is from before an update. Reload to get the
latest; everything you typed is saved." · Reload the page / Not now). Never
auto-reloads. NEXT_PUBLIC_BUILD_ID is documented in .env.example as
build-script-owned: a manual value without a rebuild makes every tab report
stale until the next real build.

**Background-check questions (research snapshot, 2026-07-17).** UP-01 and N-01 ask
"did I get your company right?" — the object of review is Tron's research
understanding, so the card renders it: `ProjectView.companySnapshot`
`{name, profile, size, industry} | null`, composed unconditionally in `view.ts`
(`composeCompanySnapshot`, word-boundary caps 80/280/140/140, null when the brief is
null or all fields empty — the partial-start emptyBrief reduction is load-bearing).
The trigger is `snapshot: true` on the BLUEPRINT bank item, DERIVED onto the
normalized `NextQuestion` at view time from `bankById` (single source of truth, never
persisted — a Q1 stored before the flag existed retrofits automatically).
`.q-snapshot` block: warn register (dotted warn left rail + `sys-label--warn`
"Research · unconfirmed" / "Research · nothing found"), a `dl` of nonempty rows, and
the hedge "This is from public sources, not fact. Your answer below overrides all of
it." Empty state uses bridge copy owning the contradiction with the stored question
text, and hides the suggestion chips + their hint ("Yes, that matches" with nothing
shown to match). For snapshot questions the ask-anchor choreography is FULLY
suppressed at every source site (the `asking` memo, the S8 first-question anchor, the
flight-resolution askRef, the sync-apply askRef, and the card's jump link): anchoring
purpose-scope put an unrelated always-highlighted marker under the user's eye (the
owner's bug report).

**Answer form (question-pane.tsx + workspace.tsx).** Suggestion chips are multi-select
toggles (`aria-pressed`), not fill-the-box buttons: a click appends the chip as a
"; "-joined segment of the answer, a second click excises exactly that segment (plus one
separator) and leaves the rest of the user's text verbatim. The textarea string stays the
only source of truth — pressed state is derived by splitting on ";" and trimming
(`chipCanon`/`chipSegments` in shared.tsx; a chip's own semicolons become commas so it can
never span two segments), so hand-edits can never desync, they just unpress the chip. A
toggle that would push past the 2000-char answer cap is refused with an info notice
("That is the 2000 character limit..."), and any edit or toggle retires a stale notice.
Submit feedback: the in-flight action (`workingKind`: send/skip/revise) disables the form
and flips the submit button to a busy state — `aria-busy`, dim-light treatment, and a
stable-width stacked-label swap (`.btn--stable`/`.btn-swap`, so "Send answer" → "Sending"
never shifts layout) — above a status row with per-path copy and a 1px `.working-rule`
light sweep (static dim line under reduced motion). The single polite live region
announces at 0 ms ("Answer sent." / skip / revise variants), at the 20 s long-turn mark
(the timer lives in a ref and survives until the turn resolves), and on brain-down;
`.btn:disabled` (light withdraws) vs `.btn[aria-busy]` (holds dim light) is a global
futurism.css distinction, and pressed chips keep a dim pressed treatment while disabled
mid-turn. **Async turn resolution:** a 202 accept keeps the busy state on and the poll
resolves the flight — rev advanced past `preSendRev` = success (the same S7 choreography:
clear refs+draft, changed flash, announce, focus), a failed `turn` record matching the
flight's promptId = `resolveTurnFailure` (one code→UI map shared with the POST error
path: brain-down gate, `invalid_turn` mints a new promptId, "network" shows the resend
notice with the draft intact). Poll cadence: 3 s only in the flight-owning tab, 8 s in
other tabs that see `turn.running`, so a few tabs stay under the 60/min GET limit; a
`turn_pending` 409 shows an info notice and lets the poll catch the tab up. A lost 202
(network error but the refetched view shows OUR promptId running) keeps waiting instead
of showing a false failure. brainDown clearing lives in `handleView` so a poll-surfaced
`brain_unavailable` failure re-sets the gate and wins the render batch.

**Brain contract.** Every governance call (turns, repairs, research distills, standards
authoring) goes through `src/lib/governance/brain.ts` `buildGovernanceEnvelope`:
JSON mode (`response_format:{type:"json_object"}`, one completion on the executor
model — the host cannot set max_tokens/temperature on this path, so output size is
bounded prompt-side: 8k chars of ops per turn, 24k for the detached turn zero), plus
the **do-not-remove privacy invariant: NO `requester`, `memoryMode:"do_not_store"`,
NO `groupName`** — without a requester the brain persists neither facts nor turns, so
confidential answers and scraped web content never reach `brain_messages`/
`brain_memories` (checked by `npm run test:governance`). Session ids: `gov_<projectId>`
/ `govres_<projectId>` / `govstd_<slug>`. Turn idempotency is the HOST's conditional
`rev`+`turn_attempt_id`-keyed write (the brain's promptId replay cache is process-local
and non-durable); the client's poll comparing `rev` is the async turn's PRIMARY success
path, not a fallback. A
per-process semaphore holds governance to ≤2 in-flight brain calls so Twilio voice
keeps priority. Feature availability equals OpenAI availability (JSON mode is
hard-wired to the executor; no failover).

**Turn contract** (`turn.ts`): model returns `{rationale, doc_ops[], status:
"asking"|"review", question, review_summary, answered_bank_ids,
open_item_guesses?}` (the last optional and parsed leniently — see the
best-guess-chips paragraph below); `rationale` is never
persisted or logged. Server-side, never trusted to the model: doc slugs must be in the
kind's blueprint allowlist, ≤12 ops (≤24 at turn zero), section markdown ≤6000 chars,
total turn markdown ≤16000 chars (`turnOpMarkdownMaxChars`) while the prompt states a
12000 TARGET (`turnOpMarkdownTargetChars`; turn zero states and enforces 24000, with
salvage) — the target/max gap is the model's character-miscounting margin: a
stated-equals-enforced 8000 failed prod turns at 8037–8828 even after repair
(2026-07-17 snag incident), and the repair system prompt now tells the model to cut
≥20% below any stated budget — plus
≤20 sections/doc, markdown sanitized (raw HTML stripped, http(s) links only) +
injection-screened at apply AND at docx render, em dashes normalized. **The
drafting→review flip is host-gated** (`resolveTurnGate` in `turn.ts`, pure +
test-pinned; owner rule 2026-07-17): a voluntary `status:"review"` only sticks when
every required bank id is covered (coverage = answered/skipped bank items + validated
`answered_bank_ids` merges) AND `openConfirmTotal` over the applied docs is ZERO —
governance never presents a draft as ready for final while it lacks the answers to
clear 100% of the `[TO CONFIRM]` markers. Otherwise the host keeps `drafting` and
guarantees the next question: model follow-up → next bank item → host-synthesized
**open-item chase question** (`pickOpenItemQuestion`, id `qi_<rev>`, `bankId:null`,
`feeds` = the marker's `slug#section`; targeted by the lenient marker count so a
malformed marker still gets chased). Once coverage is complete the chase outranks the
model's own question, one item per turn, through the SAME question pane as every
other question. Skipping a chase question is the user's explicit exit: the answer
route flags it (`qi_` prefix; skips the brainHealthy/budget checks) and the runner
force-flips to review deterministically — zero AI calls, no doc ops,
`REVIEW_SKIPPED_SUMMARY`. **The chase card also carries a deterministic "Keep as
drafted" affordance** (owner fix 2026-07-17: typing "as is" used to vanish into an
AI turn that conservatively kept the marker, and the host re-picked the SAME
question with no explanation — a verified dead loop): the card derives its keep
target from `feeds[0]` + the first `openConfirmItems` entry for that section, shows
a hint ("If my drafted assumption is already right, use Keep as drafted below…") or,
for a `confirmable:false` item, the needs-answer fine print, and a `Keep as drafted`
text button between Send and Skip that calls the resolve-item route (see the API
table; zero AI, so it stays ENABLED while the brain is down — the brain-down note
gains a keep-aware variant gated on the button actually rendering). On success the
workspace merges the server's re-picked question (or the review flip with
`REVIEW_RESOLVED_SUMMARY`), clears the old question's sessionStorage draft, owns the
receipt ("Kept as drafted. N open items left. Next question is ready." / "… Every
open item is resolved. The full draft is ready for your review.") and focus
(question heading, or review heading on the flip). The chase question's `why` says
"each one needs your call" (a typed fact or a keep). The model prompt additionally
treats plain typed keep-intent ("as is", "keep it", "fine as drafted") as settling
the targeted item — fold as confirmed fact, delete the marker — with a carve-out
for marker-only blocks and an if-unsure-ask-sharper escape hatch (secondary net;
the button is the deterministic path). Forced flips (40-answer cap; bank exhausted with no
question) still land in review with markers open, but every such summary passes
through `withOpenItemsNote` (count-free honesty note; count-free because
keep-as-drafted resolutions never rewrite the stored summary) and the client
announces "open items need your confirmation", never "ready". The confirm route's
zero-marker 409 remains the hard final gate. Pre-coverage skips draft a default
marked `[TO CONFIRM: …]` as before; chase turns serialize every marker-bearing
section verbatim and list the open items (≤10) in the user message. **The question
counter is ONE monotone number across the whole interview** (owner rule 2026-07-17,
`src/lib/governance/interview.ts`): `questionNumber(transcript)` = transcript rows
matching `isQuestionEntry` (`/^qi?_/` — bank, follow-up, and chase questions, skips
included; `revise`/`confirm`/`restyle`/`amend` rows never count) + 1. The card header
always reads "Question NN" (chase questions included — no more "Open item" label
swap), and the transcript list numbers rows with the SAME predicate so header and
history can never disagree. The secondary context line varies by phase: bank
questions "about R to go" (R = uncovered required bank items), follow-ups
"a follow-up[ · about R to go]", chase questions
"T open items left · one answer can clear several" (T = `openConfirmTotal`; markers
are never a question denominator since one answer can clear many). Two client-only
softeners smooth that unit flip (owner request + adversarial UX review 2026-07-17):
(a) *foreshadow* — while `bankLeft <= 1` and `openConfirmTotal > 0`, the chip appends
" · then the draft's open items", warning BEFORE the flip; (b) *bridge line* — the
first chase question a tab shows renders a one-time `text-xs` note directly under the
counter row, in Tron's first-person card voice ("My planned questions are done; the
ones from here clear the open [TO CONFIRM] items in the draft, so this count is open
items, not questions", the token styled `mark.doc-confirm`), tied to the question
heading via `aria-describedby="chase-bridge-note"`. First-ness is pinned per tab in
sessionStorage (`gov:{projectId}:chaseBridge` stores the OWNING chase question id, so
re-renders, StrictMode remounts, and reloads on that same question keep the line,
while any later chase question — including an amend's re-picked one, which carries a
new rev id — retires it; storage-unavailable degrades to once per chase question).
The entering turn REPLACES the polite live-region announcement with a self-contained
one naming the unit change (the visible note sits above the focused heading, where
forward reading never meets it; the live region never appends). `isChaseId`
(`interview.ts`) is the single chase predicate the counter chip and the bridge
share, so the two can never drift. Tests:
`gate:`/`chase:`/`note:`/`prompt:` block 14 and `counter:`/`folding:` block 15 in
`scripts/governance-tests.ts`.

**Open-item best-guess chips** (2026-07-19, owner directive: minimize the user's
typing; designer+critic panel — hybrid of cold-column storage and exact-excerpt
keying). Every drafting-capable brain turn (turn zero, answer, skip, revise,
amend — not restyle, whose marker-preservation gate makes stored guesses stay
valid) MAY emit an optional top-level `open_item_guesses` field:
`[{excerpt, guesses[]}]`, the marker's text plus up to 3 drop-in candidate
answers for THIS company (most likely first, prompt-instructed to be concrete
facts, "omit when no real basis"). The field is **lenient by contract**
(`validateTurn` filters junk to `[]`, never pushes to `errors[]`, so it can
never invalidate a turn or trigger the repair call) and lives outside `doc_ops`
so it counts toward no markdown budget. Guesses persist in their own cold
column `governance_projects.open_item_guesses_json` (`{key: guesses[]}`;
migration 0015) — deliberately NEVER inside `documentsJson`, whose 150k write
cap silently discards a paid turn on overflow — merged on every turn write by
`mergeOpenItemGuesses` (`src/lib/governance/guesses.ts`, pure/client-safe):
fresh emission wins, surviving markers carry forward, keys without a live
marker prune, caps 3 guesses × 80 chars × 100 keys. `guessKey` (whitespace
collapse + 200-char `confirmExcerpt` window, deliberately NOT lowercased — a
reworded marker SHOULD miss) is the single normalizer on both the write and
read side. The keep-as-drafted strip and the deterministic `qi_`-skip leave the
column untouched (orphan keys are inert and prune on the next turn write).
Read side: `hydrateChaseSuggestions` fills a chip-less `qi_` question's
`suggestions` by re-scanning the first marker of the section it feeds (the
stored chase question stays `suggestions: []` — `pickOpenItemQuestion` and both
gates remain pure and store-blind), and `attachItemGuesses` decorates
`openConfirmItems[].guesses` for the review resolver — both applied in
`toProjectView`, the turn-runner response bodies, and the resolve-item
response. UI: the chase question card reuses the existing `gov-chip` toggle
row with honest chase copy ("My best guesses at your answer, most likely
first…"); the review resolver renders a chip row above its single-fact
textarea where a tap REPLACES the draft text (still editable, still requires
Add answer — a guess can never slip through unread; shown on unconfirmable
items too, where a candidate fact saves the most typing). Missing store, old
rows (null column), or a model that never emits the field all degrade to
exactly the pre-feature chip-less behavior. Tests: `guesses:` block 24.

**Best-guess round 2** (2026-07-21, after the live observation that the model
never emitted the optional field and that the owner's obvious answer sat in
sibling sections the elided serialization hid; architect+critic panel). Three
guess sources now compose, best first, at every read edge: (1) DETERMINISTIC
repeated-label guesses — `deriveDeterministicGuesses` (guesses.ts, pure,
client-safe, derived at read time from the FULL stored documents, never
persisted, never prompted): a label index over plain/bold "Label: value" lines
(last colon wins) and two-cell table rows (value marker-free, ≤80 chars, has
alphanumerics; label ≤6 words) feeds marker-side lookups keyed by the marker's
own line label (colon tail or preceding table cell); a value only surfaces
when the SAME label resolves concretely elsewhere (one-off prose colons have
no sibling), the marker's own line never teaches, and a key whose occurrences
disagree across labels is dropped whole (a wrong chip is worse than none).
(2) The stored column (inline emissions, unchanged). (3) A **guess backfill
AI call** (owner-authorized 2026-07-21, relaxing round 1's zero-extra-calls
rule): in the runner's main advancing path only, when the turn will present
open items (entering review with markers, or a `qi_` next question) whose
markers have NEITHER a deterministic nor a stored guess (`guessGapMarkers`,
cap `backfillMaxMarkers` 10), ONE extra budget-counted brain call
(`guessBackfillSystemMessage` + `buildGuessBackfillUserMessage`: gap sections
VERBATIM ≤20k chars + brief + the marker list; response = a bare
`open_item_guesses` object parsed by `parseBackfillGuesses` →
`coerceGuessEntries`, the extraction now shared with `validateTurn`, still
lenient) runs BEFORE the fenced write (no idle poll in drafting), gap-only
merged so it can never clobber an existing guess. The call is wrapped in a
`Promise.race` wall-clock deadline (`backfillTimeoutMs` 30 s) that bounds the
brain SEMAPHORE WAIT too, and gated on `turnStaleMs` headroom
(`backfillMinHeadroomMs` 90 s = timeout + write margin): an unbounded acquire
under load must never push the worker past the claim horizon and void the
turn (critic-mandated; worst stack 90 s turn + 60 s repair + 30 s backfill =
180 s < 240 s). Budget refusal → `notifyBudgetHit`, degrade; any failure
degrades to no chips, never fails the turn. Amend/restyle and the zero-AI
`qi_`-skip never backfill; the review resolver gets deterministic + stored
chips at its read edges with no new spend. `attachItemGuesses` gained a
`documents` param (det derivation); `hydrateChaseSuggestions` now combines
det-first even over already-hydrated suggestions. Prompt-side: chase turns
now STATE the per-item emission expectation ("For EACH open item listed
above…"), and the rules name facts "established elsewhere in the CURRENT
DRAFT" as a guess source (validation unchanged either way). Tests: `det:`,
`gap:`, `backfill:`, and `prompt:` checks in block 24.

**Non-advancing turns + the four 2026-07-17 owner requests (round 12).**
(1) *Reformat the draft*: uploading a format sample mid-project previously changed
nothing visible (the sample only shapes sections the model edits later). Since
round 13d (owner rule 2026-07-17, "a new sample immediately redoes the whole
document(s)"), a successful upload — first or replacement — **auto-starts** a
whole-draft restyle run; there is no opt-in offer. The workspace owns the decision
(`handleSampleUploaded`; the control only reports the event via `onUploaded`/
`onRemoved` and, without those props — research screen — just announces): nothing
drafted → announce-only ("sections I draft from here on follow it"); a turn in
flight or another tab's turn running → the run QUEUES (`pendingAutoRestyleRef` +
queued card with a "Skip the reformat" button; `handleView` fires it the moment the
workspace is idle, whatever freed it); a previous run still active → it is killed
silently and the fresh full run queues behind the in-flight pass (a replacement
must never keep applying the superseded sample). One consent contract in every
state: queued has Skip, running has "Stop reformatting" — a LATCHED stop
(`stopRequested` on the run; the in-flight pass lands and is kept, button reads
"Stopping...", honored at the pass boundary with the stopped receipt). The page
has exactly ONE "Stop reformatting" button, on the sample control (round 15e:
the pause note's duplicate read as a glitch, broke accessible-name uniqueness,
and had already drifted behaviorally); it is RUN-gated, not name-gated
(`reformat.busy && !queued && !removeOnly` — the run outlives the sample row
after a mid-run removal, local or another tab's, so the Stop must not vanish
with the filename; only the idle "Reformat the whole draft" button requires a
sample). While the run holds the lock the question card and the review panel
LEAD with a hold banner (`RestyleHoldBanner`/`restyleHoldCopy` in shared.tsx,
test-pinned; owner report 2026-07-17: the old small bottom-of-form note left
the card looking idle-but-broken): working-rule sweep + pulsing dot (static
shapes under reduced motion, the words carry the state), the primary line
carries the pass count ("Reformatting the draft to match your sample. Pass 2
of about 4." — mirrored from the sample control's `restylePassNote`, which on
mobile can sit below the fold), and the resume line explains the pause,
promises it lifts on its own, and points at the page's one Stop button ("To
end it early, use Stop reformatting next to the format sample below" — copy
depends on the control rendering below the pane in the same column). Pointer
invariant: while a REPLACEMENT run is queued behind the draining pass the
control's Stop row is queued-gated away, so the banner swaps to "use Skip the
reformat"; stopping outranks queued, suppresses the pass count, and promises
answering back "right after that". In drafting the question content (heading,
snapshot, chips, textarea, send row — never the status lines, notices, or the
banner itself) recedes behind `.q-hold` (opacity 0.65 on permanently mounted
wrappers: no remount under focus, no layout shift; 0.65 because disabled chips
already sit at the faint token); review content never recedes (it is
legitimate reading material during the wait) and instead keeps short local
echoes on the resolver card and the revise form (no Stop pointer there — the
banner owns it once per column). The amend pause keeps its quiet bottom note.
The finish/stopped receipts close the banner's promise explicitly ("Answering
is back." / "Revising and confirming are back."). `restyleActive` state holds
the input lock and the hold banner across the setTimeout gaps between passes
(`working` briefly drops there). Guard rails around the client-chained run: a 6-minute stall
watchdog per pass dispatch ends the run honestly if no boundary arrives; a
sessionStorage flag `gov:{id}:restyle-run` (set at start, cleared at every
teardown) turns a mid-run reload into an explicit "Reformatting did not finish"
notice on the next load (same tab only — sessionStorage is the accepted floor);
mid-run turn failures announce reformat-specific copy ("what is done so far is
kept; press Reformat the whole draft to finish the rest") instead of the
answer-oriented generic, and sample REMOVAL never restyles but does skip/stop any
pending or running run. Replace and Remove stay ENABLED while a run is queued or
active (round 15c designer+critic panel: a mid-run replace supersedes the run, a
remove ends it; both land safely at a pass boundary, so the model is supersede,
never block): the control's standing helper paragraph swaps for a single
run-state line (one faint line at a time) that states the consequence and routes
stop/skip intent to the dedicated controls ("To stop reformatting and keep the
sample, use Stop reformatting" while running; "To keep the sample and skip the
reformat, use Skip the reformat" while queued), referenced from both buttons via
`aria-describedby` (`useId`, `data-qa="style-sample-run-note"`). Removal receipts
tell the truth about what they ended — queued run: "The queued reformat is
cancelled."; mid-pass: "is stopping; the pass in progress finishes first"; between
passes: "stopped" (the mid-pass check reads `inFlightRef` BEFORE
`requestStopRestyle` resolves it). The Stop button is never `disabled` while
"Stopping..." (flipping disabled under focus drops focus to body; the
`stopRequested` guard already makes a second click a no-op). **Round 16
(debt-gated resume, architect+critic panel):** the idle "Reformat the whole
draft" button renders ONLY while the server reports reformat DEBT
(`styleSample.reformatDebt` on the view, backed by the `style_sample_debt`
nonce column, migration 0014) — debt means "the sample changed since the last
COMPLETE reformat run", i.e. exactly the states every interrupted-run receipt
names the button in (Stop, Skip, failure, watchdog, reload, tab close, another
tab's claim, queued auto-run dropped on a final flip): set-at-upload +
clear-at-clean-completion needs no per-receipt bookkeeping. Upload sets a fresh
`newId("govd")` token only when ≥1 drafted non-placeholder section exists
(`uploadCreatesDebt` in restyle.ts; nothing drafted = later sections follow the
sample at draft time, and the write clears any stale debt); sample DELETE
clears it; the run's FINAL pass clears it server-side — the client sends
`restyleFinal: true` on the batch that empties `pendingRefs` (dispatch-time
finality) and `finishNonAdvancing` passes the PRE-CLAIM row's token into
`applyTurnWrite`, which clears via `CASE WHEN style_sample_debt = token` inside
the same rev+attempt+status-fenced write (atomic with the apply; a replacement
uploaded mid-run holds a different token and keeps ITS debt; a byte-identical
re-upload also re-fences — conservative, honest). Consequences the critic
forced: a VALIDATED restyle response whose applicable ops are empty lands as a
no-change SUCCESS pass (rev bump + claim clear + token clear when final) — a
`fail` there would wedge permanent false debt on a draft that already matches;
Stop pressed during the final pass reports the COMPLETION receipt, not the
stopped one (the landed pass already cleared debt, so the stopped copy would
name a button that no longer renders — `run.finalDispatched` decides); pending
refs emptied by a concurrent tab's changes (filter, not dispatch) finish with
honest non-completion copy and debt standing (stale debt is the safe
direction). With debt the control shows a hedged status line
(`STYLE_SAMPLE_DEBT_NOTE`, `data-qa="style-sample-debt-note"`, the button's
`aria-describedby` target — the client cannot diff formatting, so the copy
never claims certainty); without debt the idle state renders NOTHING (absence
of a call to action is the all-done signal) and the standing helper gains the
drift line `STYLE_SAMPLE_RESYNC_HELPER` (workspace instances only, suppressed
while the debt block shows; Replace always auto-reformats, a stronger re-sync
than the button). Focus continuity: capture-phase handlers track focus inside
the gated block, clearing on EVERY blur (a removed focused element fires no
blur, so the flag survives unmount exactly when it should); when the block
unmounts with the flag set and focus on body, focus parks on the Stop button
(start-click) or the `tabIndex={-1}` sample status line (poll-cleared debt).
Legacy rows deploy with NULL debt = no false debt (pre-16 un-reformatted drafts
re-sync via re-upload); stale pre-16 bundles never send `restyleFinal`, so
their clean runs leave cosmetic debt until a fresh-bundle run completes
(stale-bundle banner mitigates; accepted). Hidden in `done`/removeOnly; reopen
restores it while debt persists (`reopenProject` leaves the column alone). A
run is CLIENT-driven
chaining (`restyleTargets`/`packRestyleBatches` in `src/lib/governance/restyle.ts`:
non-stub, non-placeholder sections, greedy-packed to `turnOpMarkdownTargetChars`−1000
with 200/section slack, ≤20 refs/batch) of `questionId:"restyle"` turns — one budget
spend per pass; the next batch is re-packed from the FRESH view, a concurrent tab's
running turn or any failure aborts the run honestly ("what is done so far is kept"),
intermediate passes are announce-silent with a visible+announced "Pass K of about
N." counter, the finish receipt sets the mobile Draft-tab dot (evidence lands on
the other tab; never an auto-switch), and the single final receipt only
claims "the wording is unchanged" after VERIFYING it (`textContentKey`
format-stripped compare against a pre-run baseline). **Round 14b structure
adoption (owner: "I do not see it following the structure of the sample"):**
restyle turns now adopt the template's STRUCTURE, not just its look — sections
are retitled to the sample's terminology (ids never change) and reordered via
the `reorder_sections` op (exact-permutation gate, see the answer row); the
system prompt's FORMAT SAMPLE block instructs structural mirroring and carries
the SAMPLE OUTLINE digest (see the style-sample row); PDF templates get
font-height heading inference at extraction. Since round 15b the sample's NUMBERING STYLE is adopted too — but the host
remains the one numbering authority (round 6): `detectNumberingStyle`
(numbering.ts) votes over the extracted sample's heading/body line starts
(heading lines weigh 3x, sub-numbers and body-line letters never vote, a
winning style needs >=2 matching lines) and the renderers format the
host-assigned ordinals in that style — `sectionTitleText(n, title, style)`
("III. Title", "3.0 Title", "Section 3: Title") and `normalizeSectionBlocks`
sub-labels hanging off the styled ordinal ("III.1", "C.2"; decimal-zero
children drop the ".0"). The style is DERIVED wherever needed (view.ts ->
`styleSample.numbering` for the doc pane and title sites; the download route
re-derives for docx) and never persisted, so pre-existing samples adopt on
next load. Known limitation: Word AUTO-numbering lives in numbering.xml, not
the text, so only typed numbers (and PDF/md/txt, incl. the font-height
headings) carry a signal. Deliberately NOT adopted: the section SET (blueprint
compliance coverage owns which sections exist) and cross-document
reorganization. changedSections marks only sections whose position, title, or
text actually moved; the client receipt's verified "wording is unchanged"
claim is unaffected because reorders and retitles leave section markdown
byte-identical. (2) *Resolution reveal*:
`[TO CONFIRM: …]` markers are always visible in the doc pane (render-time
`splitConfirmRuns` decoration → `mark.doc-confirm`, warn text + dotted underline, no
wash; muted inside Planned sections; the shared Inline model and docx renderer are
untouched). When the flight-owning tab's turn resolves markers,
`diffResolvedMarkers` (`src/lib/governance/resolved-anim.ts`) diffs pre- vs
post-turn documents per changed section — a marker counts as resolved ONLY when its
excerpt count dropped in the committed text. TIER PIPELINE (round 16; the owner's
"animation stops at the open items" report: real chase-phase edits failed both old
tiers and nothing else moves there, so answers landed with zero motion): markers
whose OLD line is a table row route straight to the region floor (no tier may type
part of a row or strike across a cell); tier 1 anchors the verbatim replacement
between the marker's own line-bounded context anchors (now also rejecting spans
whose committed line is a table row); tier 2 (`sentenceFallback` + exported
`sentenceSpans`) matches the committed SENTENCE that replaced the marker's sentence
— sentence segmentation by forward scan (boundary = [.!?] + optional closing
quote/paren + whitespace + upper/digit/quote/paren opener; no split after 1-2
letter words like "e.g." or between digits like "3.1"; whitespace-trimmed spans,
terminal punctuation kept), candidates are 8..360-char marker-free sentences of
non-table lines that did NOT exist verbatim pre-turn, lead-stripped, scored by
token overlap against the old marker's sentence context (>=3 old tokens; >=50%
overlap; distinctiveness: >=2 matched tokens of length >=4 or >=75% overlap;
winner needs a 0.15 margin over the best different-text rival, else one positional
tie-break — the sole candidate within 10% relative offset of the old sentence —
else no inline reveal). This kills the old whole-line fallback's silent >360-char
line exclusion (real policy paragraphs are one markdown line) and its margin-free
wrong-line picks. REGION FLOOR (kind "region", the guaranteed-motion fallback):
markers no tier could anchor emit ONE region item per section — `changedLineRegion`
strips common exact prefix/suffix lines, shrinks edges past marker-bearing lines,
returns an empty span for pure deletions, and ABSTAINS (null) when the changed
block still carries a marker (a reworded marker is a NEW open item; washing it as a
resolution would lie); suppressed when the section already plays an inline item
(no double-claiming). Region items carry excerpt = first unanchored marker's
excerpt, oldMarkerText = "" (isRevealShape-valid, test-pinned). Ambiguity still
never types a guess; ≤20 items. The doc pane then plays the reveal (owner request;
re-paced 2026-07-17 round 13b "display it slower"): per item, auto-scroll
(pane-container-scoped, 420 ms; 60 ms same-section) → old marker struck out (900 ms
over a 700 ms CSS fade; the 200 ms rest is reading time — change together; 120 ms in,
the pane CENTERS the struck marker itself — the section jump only reaches the section
top, and a long section played the whole show below the fold, owner report) →
replacement RE-WRITTEN over committed text at ~30 ms/char (60 ms ticks,
ticks = clamp(ceil(len/2), 20, 60), closed-form chars so short texts spend the full
1.2 s floor in 1-2 char steps; 3.6 s ceiling; sentinel-injected private-use chars
toggle span styling across emphasis boundaries; caret STEADY while typing) →
1 s hold with the caret BLINKING (removed at hold end; deletion-only items get no
caret). REGION BEATS (kind "region"): optional section jump, wash on (mode
"region": `regionWashLines` spans — per non-blank non-table line, lead-stripped,
may be empty for all-table blocks — rendered via new RA sentinels / as
`.doc-resolved--active`; an all-table block mounts the section-level
`.doc-sec--region` outline instead), one centered scroll (selector falls back
`.doc-resolve-old, .doc-resolved--active`, then the section element), then a
`regionHoldMs = clamp(1800, len*6, 3200)` hold — no strike, no typing, no caret;
the sticky bar names the removed marker ("Cleared · [TO CONFIRM: excerpt…]"
struck at full opacity, `.doc-bar-strike`, never faded). estimateItemMs prices
regions additively as (jump) + 300 + regionHoldMs (the 300 = the runner's
120 + 180; inline math untouched). Region CSS follows the authoring rule: static
declarations ARE the final state (reduce kills all animations); the pulse
keyframes are default-motion garnish. CLEARED CHIPS: `clearedSectionCounts`
(pure, count-delta per changed section) is computed at diff time in BOTH the
flight-landed and idle-rev-advance branches and rendered as a persistent
"Open item cleared" / "N open items cleared" heading chip until the next rev
(cleared with the marks; keepItem drops it section-scoped) — the durable record
that survives skips, Escapes, and degraded theater. The played list is trimmed at
startShow to min(5 items, a 15 s budget
estimated with the REAL per-item beats), always ≥1; the overflow note's denominator
is the ORIGINAL diff count ("Showed n of m resolved items..."). Every diffed
INLINE span keeps a static `.doc-resolved` wash until the next rev (region items
never settle to a wash — the block-wide claim was already the weakest honest beat;
the Updated treatment and the cleared chip carry the record), a sticky "Showing
resolved items · i of k / Skip the replay" bar rides the pane, and ANY user intent
(scroll/jump/Escape/skip, a new turn, a newer rev) ends it instantly at the final
state. Perf contract: the doc pane memoizes per-section mark arrays and keys the
section parse memo on reveal PRIMITIVES (item/mode/chars), so only the revealing
section re-parses per tick. REDUCED MOTION (round 13e) plays a SIMPLIFIED show
through the SAME runner (reduce sampled once onto showRef): section jump skipped,
ONE centered behavior:auto scroll inside a 1100ms static strike beat, instant
caret-free swap (RevealState mode "swap"), length-scaled rest
reducedRestMs = clamp(1600, len*12, 3200); nothing in that path depends on a CSS
animation (futurism.css kills them all under reduce). Planning math
(typingTicks/estimateItemMs/planShow, per-variant beats, 15s budget, 5-item cap,
first-item exemption) is pure in resolved-anim.ts and test-pinned (block 17).
Timer-chain invariant: exactly ONE pending later() at all times (strict
continuation passing; a sibling schedule double-advances past the seq guard).
HIDDEN TAB: a show starting while document.hidden parks in the pending queue
(hidden timers clamp >=1s, later ~1/min — it would play off screen in slow
motion); hiding MID-show settles it at the final state (endShow(true)); on
return, a 700ms grace then a fetch-guarded flush (drops silently if the rev
moved — never a start-then-abort stutter). Breakpoint flips: widen-to-desktop
flushes a mobile-queued show (the Draft tab, its only other flush path, ceases
to exist); narrowing mid-show settles it. All parked-show state flows through
ONE setter (ref + render mirror); a counter-free "Resolved items are ready to
show in the draft · Show me in the draft" line in the Questions pane surfaces a
queued show to narrow-window users (the receipt owns all numbers). keepItem and
the sync applyTurn merge viewRef in place (equal revs — the rev-change
invalidation never runs), so they invalidate reveal state themselves; keepItem
SECTION-SCOPED (marks over byte-identical sections keep their owed washes;
never re-diffed — a keep dressed as a resolution reveal would lie). CROSS-TAB
(owner report 2026-07-17 "no longer see the animation" — they were watching a
second window; only the flight tab ever diffed): the flight tab broadcasts its
diffed items on a per-project `BroadcastChannel` (`gov-reveal:<projectId>:v2`,
same-origin; the v2 suffix shipped with region items — an old bundle's
field-only shape guard would accept a region item and TYPE its multi-line span
as an inline reveal, so mixed-bundle deploy windows simply do not exchange
shows, the documented no-BroadcastChannel degradation; `isRevealShape` is now
also closed-world over `kind`: absent/"inline"/"region" only) at the moment it
plays them; a sibling tab plays the IDENTICAL
show through the same play-or-queue helper (shared with the flight branch so
mobile/hidden queueing can never drift) but ONLY at the exact sender rev —
same rev = byte-identical committed text, so the spans stay honest; received
items are shape-validated (`isRevealShape`, test-pinned) and capped at
MAX_REVEALS. A broadcast arriving before the watcher's poll is held in a ref
and consumed by handleView's idle rev-advance branch when the revs match; a
held show whose rev passes without playing (own flight owned it, a show was
already playing, or the project moved on) is dropped — it can never honestly
play later. Keeps and direct merges never broadcast (they never run the
diff); watchers get no ask-anchor jump (askRef null — they didn't ask);
browsers without BroadcastChannel keep single-tab behavior. The reveal
pipeline logs one-line [gov-reveal] decisions (counts and revs only, never
document text) at every silent branch so an owner devtools screenshot
discriminates: no lines = stale bundle, "no resolved markers diffed" = diff
gates, "reduced motion" = the RDP case, "queued"/"parked" = tab state,
"trimmed" = budget, "broadcast:" = cross-tab path. Mobile: never auto-switches
tabs; the show queues and plays when the Draft tab opens (superseded by newer revs). The live region stays count-delta
only — the reveal adds zero announcements. (3) *Monotone counter*: above.
(4) *Change previous answers*: every question row in the transcript disclosure
(folded via `foldTranscript` — amend rows collapse into their target row, showing
the LATEST effective answer, a "changed {date}" suffix, and a one-step
`was: "{previous}"` line) gets "Change this answer" (skipped rows: "Answer it now"),
an inline prefilled editor (sessionStorage draft `gov:{id}:amend:{index}`, send
disabled while empty/identical, one editor at a time) that sends a `questionId:
"amend"` turn (`preserveDraft` — the pending question's own draft survives; the
choreography skips focus-stealing for amend/restyle turns and the paused question
card explains: "Paused while I rework an earlier answer. This question is not going
anywhere."). `TranscriptEntry` gained optional `amendsIndex` and `feeds` (question
rows written since 2026-07-17 store their feeds so amends can focus the right
sections). Tests: block 15 in `scripts/governance-tests.ts`.

**Open-items resolver (zero-marker finals, owner ruling 2026-07-16).** Every
`[TO CONFIRM: …]` marker is an assumption Tron made; a FINAL draft carries none, and
each is resolved BY THE USER, never silently accepted. Marker machinery lives in
`markdown.ts`: `countConfirmMarkers` (lenient `/\[TO\s*CONFIRM/gi` count — the ONLY
number the confirm gate and user-facing totals may use; it sees malformed markers the
display parser misses), `scanConfirmMarkers` (display regex `{0,400}` innards →
`OpenConfirmItem`: excerpt ≤200 + `occurrence` (0-based among identical excerpts in
the section) + line-scoped `contextBefore/After` windows (~110 chars, word-boundary
cut) + `confirmable`), and `stripConfirmMarker` (the deterministic keep-as-drafted
removal; refuses `needs_answer` when the containing paragraph/list item/table cell
would end up with no letter or digit — the marker IS the content there).
`ProjectView`/turn responses carry `openConfirmItems` (sliced to 50) AND
`openConfirmTotal` (lenient, never sliced). UI (`open-items-resolver.tsx`, rendered
inside the review panel ABOVE the revise form, sibling of it — its `<form>` must
never nest inside the revise form). **Owner rule 2026-07-17 (round 14c): asking the
user for a fact ALWAYS uses the question-card structure, in review exactly as in
drafting** — the prior accordion list (round 10) was the "inline way of asking
questions" the owner banned. The resolver therefore renders ONE item at a time in a
`div.panel` card mirroring the drafting chase card's anatomy: sys-label header
"Open item KK of N" (K = 1-based position among RENDERED rows, zero-padded; " listed"
suffix when the lenient total exceeds N — never "Question NN", which is
transcript-derived (`questionNumber`) and staging appends no transcript rows, so a
frozen repeated number would violate the monotone-counter rule) + the drafting chase
counter chip word-for-word ("T open items left · one answer can clear several", T =
`openConfirmTotal`; singular drops the tail); an `h4` heading (subordinate to the
review panel's h3, `tabIndex -1`, the focus target, `aria-describedby` the position
label) wording the item through `pickOpenItemQuestion`'s exact formula incl. the
empty-excerpt fallback; a dim why-line ("Keeping is instant; typed answers go
together as one revision."); the always-visible context quote with the marker
highlighted via `mark.doc-confirm` (the user must see WHAT they would be affirming —
the excerpt label alone invites rubber-stamping); the "See the text this is about"
jump link; and a ≤500-char answer form. Actions: submit is "Add answer" / "Update
answer" (plain `.btn`, deliberately NOT `btn--primary` and NOT the word "Send" —
"Send" and the one glowing primary are reserved for actions that actually run the
AI), "Keep as drafted" (`confirmable` only) → `POST .../resolve-item`, "Remove this
answer" (staged only, unstages), "Send just this one" (Not-resolved retry only), and
a persistent honesty anchor ("Added answers are not sent yet..."). "Add" stages
(state + sessionStorage `gov:{id}:item:{key}`, key = doc:section:excerptHash:occ with
occurrence-shift migration) and auto-advances to the next unstaged item (forward scan
WITH wraparound; a backward wrap announces its new position; when none remain focus
moves to the Send button); "Update" stages in place and never advances (the user came
back to fix a typo — advancing would catapult them at the primary). Manual nav:
"Previous item"/"Next item" text buttons (disabled at the ends, no wraparound —
spatial nav orients, goal nav hunts) plus a closed-by-default `<details>` chip queue
("All open items · S ready, R to go", "Listed open items" when the total exceeds N;
open state persisted per project in sessionStorage) of `.gov-chip` NAVIGATION buttons
— plain buttons, NEVER `aria-pressed` (that class's toggle grammar belongs to
suggestion chips; a "pressed" chip that navigates lies to assistive tech):
`aria-current="true"` marks the shown item, and state rides visible label words
("· ready" / "· sending" / "· not resolved" / "· new") plus garnish classes
`.gov-chip--staged`/`.gov-chip--danger`, grouped by document (sys-label headings only
when >1 doc has items, indices stay global). The "New" flag survives programmatic
cursor moves and clears only on user navigation to the item or staging. The cursor is
persisted (`gov:{id}:resolver:cursor`) and reconciled against every fresh list:
vanished cursor → same index clamped; after a keep → the existing next/prev retarget
now focuses the card heading (all-clear paragraph when the queue empties); after a
batch → first surviving Not-resolved row's heading, else the card heading / all-clear
(the resolver NEVER pushes to the live region after a batch — the workspace owns that
receipt and the polite region replaces, never appends). All staged answers batch into
ONE revise turn behind the single `btn--primary` in the resolver ("Send S answers",
in an `answer-sticky` bar with the live meter, hidden at S=0): a composed numbered
message (~2000-char cap; excerpts quoted at ≤60 chars) sent through
`submitTurn({message, focusSections})` — the resolver NEVER touches the revise
textarea or its `gov:{id}:revise` draft key (`inFlightRef.preserveDraft`). When
`total > 0` but zero rows parsed, the card is replaced by an honest "could not
display cleanly" note pointing at the revision box. The resolver locks on
`working || featureDisabled || restyleActive` — keeps INCLUDED: a reformat run holds
its latch across inter-pass gaps where `working` drops, and a keep is a server-side
document mutation that would invalidate the run's pending pass (the card shows the
"Paused while I reformat..." note). A second staging cap bounds the batch by SECTION
REWRITE COST: the model re-emits every touched section in full and is told to stay
under `turnOpMarkdownTargetChars` (12000) of markdown, so a batch whose inherent
re-emit cost exceeds that produces truncated rewrites or validation failures the
repair pass cannot fix — Add answer refuses when the sum of the distinct target
sections' current markdown (+200 slack each) would pass 12000−1000, with "send these
first" copy. turn-runner logs validation failures (`[governance] turn invalid …`)
and crash stacks to the PM2 site log; never answer content. After the turn, the resolver diffs by stable key:
survivors flip to "Not resolved" (card note + "Send just this one" + danger chip),
vanished staged rows clear, brand-new rows flag "new"; the live-region receipt
(workspace-owned) reports the TRUE `openConfirmTotal` delta, never per-item claims
(the model may reword a marker
instead of deleting it — a reworded marker is a new item, not a resolved one). The
confirm button stays enabled-with-intercept (undrafted sections first, then open
items) plus a persistent helper line; the revise-turn prompt (`buildTurnUserMessage`)
instructs: fold a user-stated fact in and DELETE that marker, never touch a marker
the user has not resolved (unless explicitly asked to fix/remove it), never re-add a
marker for a confirmed fact. Keep-as-drafted stays enabled during brain outages (its
route never touches the brain); batch send locks with the usual `brainDown` machinery.
Transcript records keeps as `qId:"confirm"` rows ("Kept as drafted ·  …", numberless,
same as revise rows). Tests: the `markers:` block in `scripts/governance-tests.ts`.

**Placeholder honesty (undrafted-section contract).** Blueprint scaffolds seed every
section's markdown with its placeholder string; `placeholderSectionMap(kind, docs)`
(`blueprints.ts`) detects sections still holding it by EXACT string equality
(host-computed, model-unspoofable — model markdown is sanitized so never
byte-identical; never replace with a prefix heuristic; editing a placeholder string
later fails OPEN for pre-existing rows, bounded by 30-day retention; stub docs are
skipped — `stubDetermined` keys their pending/determined copy on a `determination`
section existing, which only `set_stub` writes). The map rides `ProjectView.
placeholderSections` AND the `/answer` turn response (docSlug → [sectionId]; the
client applies it like `changedSections` so a freshly drafted section swaps Planned →
Updated in the same render — there is no idle poll in drafting to fix it later).
Consumers: the doc pane renders these sections with a dotted gray "Planned" chip, a
receded italic body (suppressed while the section is the ASKED-about one — the ask
choreography wants that text read; `.doc-sec--planned:not(.doc-sec--asking)`), and one
status-aware doc-level note; the review panel lists them as jump links ("Sections not
yet drafted (N)") with a one-click prefill of the revise box; confirm refuses while
any remain (see the route table); the .docx renders an italic amber notice INSTEAD of
the scaffold body (draft AND final paths — one shared loop, and rows confirmed before
this shipped still render honestly) and the zip README adds an undrafted-sections
line. Self-heal: `serializeDraft` always includes still-scaffold sections verbatim
tagged `(NOT YET DRAFTED: template text)` (many sections are fed by NO bank question —
9 in nist_ai_rmf — so feeds alone can never reach them), and a rules() line tells the
model to fully replace any it can draft from the current answer or revision.

**Q&A history (question-pane.tsx).** ONE `TranscriptList` instance is ever mounted
(two would cross-leak the per-row `gov:<id>:amend:<i>` sessionStorage draft keys), in
one of two variants (round 15, owner report 2026-07-17 "not letting me change previous
answers"):
- **quiet** (drafting AND done): one uncontrolled collapsed
  `<details class="transcript">` disclosure above the current-question card
  ("Previous questions (N)", "…and revisions (N)" when revise/confirm/reopen rows
  exist), so the card stays the left column's top anchor at any answer count
  (round-8 decision); expanded, the list scrolls inside `min(40vh, 22rem)`
  (`.transcript-scroll`, `tabIndex=0` + `role="group"` for keyboard scrolling).
- **promoted** (review, rendered INSIDE the review panel between the open-items
  resolver and the revise box): a first-class "Your answers · N" block (N = question
  rows only) with FLAT rows — no nested disclosures, the burying that produced the
  owner report. Each question row: dim `Qn · question` line, effective answer in
  full text color (explicit `var(--xl-text)` + `max-w-none`: futurism.css dims bare
  `p`) clamped to 2 lines with the full text as `title`, amend "was" line, and an
  ALWAYS-VISIBLE `Change` / `Answer it now` linklike button (disabled, not hidden,
  while a turn runs) opening the same inline amend editor. History rows (revise/
  confirm/restyle/reopen) render as faint one-liners in place; revise rows keep
  their request text (clamped) since it is user content. Scroll region
  `.transcript-scroll--promoted`: `min(45vh, 24rem)` (32vh below 1024px),
  `overscroll-behavior-y: auto` so touch scrolling chains to the page (the shared
  rule's `contain` would trap it in an always-expanded region). The revise box below
  it gains a lead line ("Something else off in the text itself? Ask here and I will
  revise the draft.") framing the two tools: change a fact vs change the wording.

Numbering skips revision, kept-as-drafted, format, and reopen rows (`Q1…Qn` count
bank/follow-up entries only via `isQuestionEntry`; revise rows label "Revision
request", `qId:"confirm"` rows label "Kept as drafted · <excerpt>"). Answers stay inert
plain text (no markdown rendering). After a landed amend, focus returns to the row's
control (summary or Change button) with the review heading as fallback; `openEditor`
discards a saved sessionStorage draft equal to the current effective answer (leftover
from an amend that landed while the list was unmounted — it would prefill a dead
editor via the identical-text guard). The stored pre-round-15 reopened summary
("…under Previous questions…") names a control that no longer exists in review, so
the client remaps it by PREFIX to the current wording, suffix (open-items note)
preserved (`remapLegacyReopenedSummary`, interview.ts; drops out naturally with
30-day retention). `withOpenItemsNote` is idempotent (non-advancing review turns
re-wrap `priorSummary`; without the guard repeated amends stack the note).

**Rendering + host-owned numbering** (`numbering.ts`, client-safe, bounded-quantifier
regexes only). Drafting edits one section at a time with the rest of the draft elided,
so the model can never keep manual section numbers consistent — the host numbers
instead. Both renderers (doc pane and docx) parse section markdown through the shared
`markdown.ts` parser, then through the same `normalizeSectionBlocks` render-time pass:
manual number prefixes are stripped from headings ("3.", "3)", "3.1", including a
number-only first inline node before markup; conservative — a `.`/`)` separator plus
a following letter/quote/bracket is required, so "30 days notice" / "2026 Budget"
survive), heading depth is rebased to
the section's shallowest level, and deterministic decimal numbering is applied:
sections "1., 2., …" in stored order (`sectionTitleText`), inner headings "n.m" and
"n.m.k", deeper levels unnumbered. Because normalization is render-time only, stored
rows with drifted manual numbers render clean with no regeneration. Round 16b
(manual-heading promotion): restyle/auto-reformat turns mirror a format sample's
literal numbers into stored markdown as bare un-marked lines ("3.1 Data handling"),
which the paragraph parser glued into the preceding paragraph — number inline with
body text, no break. `promoteManualHeadingLines` (numbering.ts) now runs inside
`parseMarkdown` (the ONLY parse entry, so both renderers inherit it): line-start
multipart decimals ("3.1", depth = dotted parts capped at ####), multi-letter romans
("IV.") and "Section 2:" shapes — all strict subsets of `NUM_PREFIX` — promote to
real headings when the remainder is title-shaped (≤100 chars, opens uppercase or
`["'(`, no terminal punctuation), with the manual number removed at promotion so the
host label can never double even through reveal sentinels. Bare "1."/"1)" stays
ordered-list territory (promoting it would destroy real lists; a glued "7." sentence
becoming a renumbered one-item list is a pinned known limitation); non-title numbered
lines ("2.5 GB of logs are retained.") are left byte-untouched — body numbers are
content, never stripped or re-flowed; single-letter romans ("V. Smith…") promote only
with a multi-letter roman peer in the same section OR as letter-run members (below);
lines carrying mid-reveal
old-strike/caret sentinels (U+E002-U+E005) never promote (no heading flicker while
typing), settled-wash sentinels (U+E000/U+E001) are skipped and preserved. Insert-only
and idempotent. Round 18c (alpha-marker promotion): single uppercase LETTER markers
("B. Data Handling", "C) Access") — the shapes 16b deliberately excluded, which
resurfaced when a bold-same-size lettered PDF sample extracted flat and the model
mirrored bare letter lines — promote under a RUN guard: >=2 chain candidates with
strictly consecutive letters (B→C) and the SAME separator, each pair separated by at
least one non-blank non-marker content line (adjacent lettered lines are
enumeration-shaped content, "A. Email / B. Chat logs", never headings); a second
single-letter marker in the remainder rejects abbreviation chains ("U. S.
obligations"); chain membership is computed on a sentinel-stripped shadow so a
punctuated/washed/mid-reveal member stays a LINK (its neighbours never unpromote
across reveal ticks) while itself staying prose; the promotion gate widened from
/[\dIVX]/ to /[0-9A-Z]/ (an all-letter section previously bypassed the pass
entirely). A LONE letter line never promotes (indistinguishable from "A. Smith
Policy" — pinned limitation), and consecutive-initial rosters separated by content
("J. Doe" / "K. Lee") promoting is the pinned accepted residual (same risk profile
as the roman peer rule). `normalizeSectionBlocks` applies the same run logic
(ascending letters, gaps allowed — heading-ness is already established) to real "#"
lettered heading SETS, shedding their letters (including whole-node bold "**B.**"
markers, husk dropped) before host labels so "3.1 B. Data" doubling can't happen,
while a lone "## A. Smith Policy" and `sectionTitleText` titles keep their letters
forever (no peer context on the title path). Prompt side, the
RULES ban starting any title/heading with an outline marker (numbers, letters
"A."/"(a)", romans "IV."), require cross-references by section NAME (host renumbering
breaks numeric ones), and define the mapping for user-cited numbers (section 3 = third
section in CURRENT DRAFT order); the FORMAT SAMPLE mirroring excludes numbering, and
the upload helper copy says numbering is applied automatically. Web hierarchy: h3
section titles, `doc-h4`…`doc-h7` classes for the four inner levels (h7 is a visual
class on an h6 tag; no heading renders dimmer than body text; inner-heading top
margin steps down with depth, `mt-5` levels 1-2 / `mt-4` levels 3-4, mirroring the
docx ladder). Docx: section titles
Heading1 (`before:280/after:120` twips), inner levels Heading2…5 with a stepped
spacing ladder (`240/120`, `200/100`, `160/80`, `160/80` — the docx package's default
heading styles carry NO paragraph spacing, which shipped as "headings run tight
against body text" in Word) and `keepNext` on every heading incl. section H1 (no
heading stranded at a page bottom), and every ordered list mints its OWN concrete
numbering instance (`gov-num-<i>`) — a single shared
instance makes Word continue one counter across the whole document, which shipped as
the "numbers randomly throughout" bug. Round 19 list model v2: each instance is a
TWO-level config whose level-0 `start` is the run's literal first number (docx 9.7.1
copies `levels[0].start` — positional, level 0 must stay first — into a
`w:startOverride`, so a paragraph-split "3. 4." run renders 3, 4 instead of
restarting at 1: "loses the count" fixed, stored drafts self-heal), with
decimal/upperLetter/lowerLetter formats (adjacent lettered lines "A./B./C." parse as
letter LISTS — the enumeration side of the round-18c partition — instead of gluing
into a paragraph; `<ol start>` + inline `listStyleType` on the web, the `type`
attribute loses to the `list-decimal` utility class); ONE sub level nests at level 1
(indent ladder 720/1440 hanging 360, matching the package's default bullet levels;
subs restart per parent via Word's default lvlRestart; ordered subs under BULLET
parents mint their own per-run reference since the parent never fires level 0; the
first ordered sub's format/start wins per reference, later mismatched subs coerce —
pinned). Bare number-only lines ("5." alone — Word auto-number artifacts mirrored
from badly extracted samples) are dropped by a context-guarded pre-parse pass
(`dropOrphanNumberLines`, ordered BEFORE heading promotion so an orphan digit line
can never manufacture between-content and flip an adjacent lettered enumeration
into headings; soft-wrapped prose numbers "capped at\n5.\nGB" keep gluing, content
intact; mid-reveal-sentinel lines survive while typing, wash/region sentinels do
NOT protect a line from the drop). `ORPHAN_DOT` strips heal stored ".7.1 Policy"
headings (a lost leading component: strip in normalize + promote at parts+1 depth,
capped 4). Regression-checked by `npm run
test:governance` blocks 4b and 28.

**Research pipeline** (`scripts/governance-research.ts`, spawned detached by
`kick.ts` after the DB claim, `NODE_OPTIONS=--max-old-space-size=256`, 15-min wall
clock, heartbeat per step, log `/var/log/aiwebsite-governance-research.log` with
`[<id8>] <ISO> step=` prefixes and NO content bodies): 30-day same-user+domain brief
reuse (kind-aware, see below) → site crawl (≤12 pages, 300 KB/page, **SSRF-hardened
`safeFetch`**: http/https
+ default ports only, custom DNS lookup rejects loopback/private/link-local/IMDS/CGNAT
ranges and pins the validated resolution for the connect — DNS rebinding safe — manual
redirects ≤3 re-validated per hop; page dedupe on BOTH the pre-redirect URL and the
post-redirect finalUrl via `crawlDedupeKey` — https-forced, `www.`/trailing-slash/query
collapsed — so a www.→apex redirect never spends a second slot of the 12-page budget)
→ profile mini-call (moved BEFORE mentions: it anchors them; null-tolerant, checkpointed)
→ company Tavily (3 advanced queries → top 50 by score, anchored on the profile's
company name, fallback `companyNameFromTitle` — segments split only on `|`/`·`/spaced
dashes, chosen only via a word-bounded ≥3-char domain-label match, else the bare domain
label with domain-scoped queries only (2 instead of 3: an unscoped quoted floor anchor
like `"xl"` poisons the pool) — anchor sanitized against query-operator smuggling;
checkpointed in `research_progress_json` with PRESENCE semantics — an empty paid-for
result set never re-spends on requeue, same for the industry search) →
industry Tavily (top 20) → **standard applicability probes**
(≤3 per-kind hardcoded Tavily queries from `src/lib/governance/probes.ts` targeting
the chosen standard's conditional attributes — e.g. government/defense contract work,
EU market presence, generative-AI products, existing ISO/SOC certifications — company
name interpolation sanitized against query-operator smuggling, results filtered
deterministically: individual-profile hosts dropped, must mention company or domain,
top 6/query; checkpointed PER PROBE ID with presence semantics, empty results
included, so requeues re-spend nothing even on zero-hit probes; skipped entirely when
neither pages nor mentions exist) → map-reduce distill (Tavily snippets
only; `<<<UNTRUSTED-nonce>>>` fencing; identity gate against name-collision companies;
personal data only as public role holders; ≤12 brain calls, lowest-tier chunks dropped
first with `gaps:["research_truncated"]`; **probe sources are chunked FIRST** so
truncation sheds generic mentions before standard-specific evidence; probe facts are
host-annotated `(probe: <id>)` by source URL and REDUCE may attribute
`applicabilitySignals` only to those ids) → ≤9000-char brief (injection-screened,
`research_flagged` on hits; new fields: `companyName`, `probedKind`, and ≤5
`applicabilitySignals` — hedged public-source observations `{probeId, trigger,
finding, source, confidence: likely|unclear}` with trigger labels re-attached
host-side from the catalog, unknown probe ids dropped, source URLs validated
http/https-no-creds or blanked; prose fields cut at WORD boundaries via `cutAtWord`
— gaps ≤120 chars each, no more mid-word "month-t" fragments in prompts — URLs/ids
keep hard slices; signals shed LAST under the size ceiling; drafting
prompts render them as "observations to confirm with the user, not determinations"
and a rules() line forbids determinations from signals — anything drafted from one
carries `[TO CONFIRM]`) → turn zero: a COMPLETE best-effort first draft of every
non-stub section (never placeholder language; unknowns marked `[TO CONFIRM: …]`; one
call for the AUP (`usage_policy`), the `ffiec_aup` hub alone then 2-doc groups, one
per 2-doc group for the standards sets (`turnZeroGroups` in turn.ts, pinned); the turn-zero
system message states the 24k budget — the shared rules' 8k line used to contradict
it — plus the 6k per-section cap, and turn zero gets a 24-op ceiling vs the answer
turns' 12). **Stub docs never go to turn zero**: determinations rest only on
user-confirmed facts and none exist yet, so their scaffolds honestly read as pending
(this removed a whole failure class: the stubs group used to receive a
self-contradictory "draft every non-stub document" prompt and reliably failed
validation). A group whose output fails validation gets the answer-route parse
ladder: concrete error strings logged (host-generated, never content), ≤1 repair
call per group and ≤`turnZeroRepairMaxCalls` (2) per run (90 s, ≤48k raw slice,
budget-counted, skipped inside the wall-clock handoff reserve), then **op-level
salvage** — `validateTurn` returns the individually valid ops (`salvageOps`, turn
zero only, trimmed in order to the 24k budget) so one oversized section no longer
throws away a whole group; whatever still fails keeps its scaffold, which the UI
marks Planned and every later turn offers for drafting → ONE handoff write
(scaffold docs + bank question 1 + `status:'drafting'`). **Research audit**
(`research_audit_json`, migration 0013): the handoff write also stores a ≤20k
`ResearchAudit` envelope IN THE SAME STATEMENT as the brief (they can never
disagree; that atomicity is why it is NOT cleared at claim time — a run dying
before handoff leaves the previous brief+audit pair intact): map-phase
`{fact, source}` provenance (≤60, what the reduce step drew from — any brief
sentence is auditable against it), the model's suspicion notes (≤20, screened via
`screenSuspicionNote` — redaction stubs, not line drops, since notes quote what
they report), regex screen-hit slugs (≤20, `turnzero:`-prefixed for applyOps
hits — distinguishes the two `research_flagged` causes), and step counts. NEVER
raw page bodies or Tavily snippets; NEVER rendered into any prompt (tested);
`research_progress_json` checkpoints are still purged at handoff. Deleted with the
row; rides the account export. Rollback note: pre-0013 code leaves the column
stale on re-research — detectable via `audit.createdAt` vs `brief.distilledAt`.
The done log line reports `screenHits=N suspicion=N` so the flag rate is
diagnosable from logs alone. **Kind-aware brief reuse**:
`latestBriefForDomain` (still keyed user+domain, `normalizeBrief` defaults legacy
briefs, returns `{brief, donorId, donorFacts}` — the borrowing project's audit
carries the donor's facts plus `reusedFrom` lineage, because the donor row and its
audit are deleted independently and a reused brief must stay auditable) prefers a
candidate whose `probedKind` matches the project kind (reused
as-is, zero spend); a brief probed for a different kind gets a probe-only top-up —
≤3 Tavily + 1 brain call (`PROBE_TOPUP_SYSTEM`, same UNTRUSTED fencing/identity
gate/personal-data rules), signals REPLACE the other kind's, confirmation questions
prepend `openQuestions`, `distilledAt` stays anchored to the original research so
top-ups never extend the 30-day window; `probedKind` is only stamped when the probe
pass ran to completion (budget/outage truncation stays topping-up-eligible; brain
failure adds `gaps:["probes_skipped"]`). The `research_failed` write preserves
checkpoints so retries never re-spend Tavily credits. Degradation: Tavily down →
site-only brief with gaps; site unreachable → Q&A carries the load; brain down at
distill → `research_failed` with Retry / "Start the questions anyway". Deploy marker
fresh → checkpoint + exit as `queued`. Cost caps (DB ledger `governance_usage`,
restart-proof, covers the detached script): ≤8 Tavily calls/run (worst case 7:
3 company + 1 industry + 3 probes),
`GOVERNANCE_TAVILY_DAILY_CAP` (default 300 ≈ 600 Tavily credits/day; confirm the
Tavily plan covers ~18k credits/month) global/day, `GOVERNANCE_BRAIN_DAILY_CAP`
(default 1500 ≈ $150/day worst case — JSON mode bills at executor-model rates,
~$0.10/turn) global/day; per-person 25 creates/day (owner directive 2026-07-16:
person x5, global x10). At any cap: friendly 429/queued copy; downloads always work.
**Admin budget exemption** (owner directive 2026-07-16): accounts whose sign-in
email matches any comma-separated `ADMIN_EMAIL` entry (default `adam@xl.net`)
bypass the creates/day cap and never spend the shared `governance_usage` ledger —
drafting turns, research kicks, and the detached script's Tavily/brain calls all
skip `trySpendBudget` (`isBudgetExemptEmail`/`isBudgetExemptProject` in
`src/lib/governance/budget.ts`; the script resolves the owner via
`ownerEmailForProject`). Admin spend is therefore invisible to Troy usage
reports by design. Concurrency/quality guards (3 active projects, 40
answers/project, 3 research runs/project/day, 2 concurrent research jobs) still
apply to admins — they protect the box, not the wallet.

**Runtime budget overrides + the Troy approval loop.** Effective caps =
`governance_meta` override (`budget_override_{brain_daily,tavily_daily,
creates_per_user_day}`) if present, else the env default — BOTH clamped into
`[BUDGET_FLOOR=1, BUDGET_CEILINGS]` (brain 5000 ≈ $500/day, tavily 2000, creates
100; `src/lib/governance/{config,budget,approval}.ts`), so neither a subverted
approval nor a mistyped env var can authorize unbounded spend. When any budget is
hit (create cap, drafting turn, research kick, or the detached script's spends),
**Troy Netter <Troy.Netter@ai.xl.net>** emails `ADMIN_EMAIL` — throttled to one
email per budget type per UTC day via `governance_meta` stamps written only after
a successful send (a Resend outage must not eat the day's alert), stamp cleared
when that budget changes. The admin replies with strict line-anchored commands
(`SET GLOBAL BRAIN <n>` / `SET GLOBAL TAVILY <n>` / `SET PERSON CREATES <n>` /
`RESET <target>`; parsing stops at the first quoted-reply marker, and alert
emails only ever show placeholder syntax, so quoted text can never execute).
The reply arrives on `/api/webhooks/resend` and routes to the host via the
module's `channels.email.onInbound` hook (v1.6 — the tee that re-verified
svix on a cloned Request is retired; routing truth is unchanged: envelope
recipients, so BCC'd approvals still reach Troy) and is processed
fail-closed by `approval-inbound.ts`: svix-verified by the module; delivery deduped on
`email_id`; sender must be an exact-match `ADMIN_EMAIL` member; EXACTLY ONE
direct `Authentication-Results` header (duplicates = forged-header ambiguity =
reject; the ARC fallback is not accepted here); DKIM-aligned verdict via the
module's `parseEmailAuthVerdict` pinned to `memory.emailAuthservId`; the
DKIM-covered `Date` must be <48 h old (replay guard past the 14-day dedupe
prune); `message_id` deduped post-verification. Out-of-range values are
REJECTED, never clamped. Every change writes a `budget_audit_*` row
(who/old/new/emailId) and a threaded confirmation email (inbound-derived
header values sanitized: CR/LF stripped, length-capped). Unverified mail gets
NO reply (backscatter/probe hygiene) — adam gets a throttled WARN instead, so
real mail never vanishes silently. Mixed-recipient mail (Tron cc'd) is handled
by BOTH personas by design. The loop stays active under `GOVERNANCE_ENABLED=0`
(it is an admin control plane, not user spend). Escape hatch if inbound email
breaks with a bad override active:
`DELETE FROM governance_meta WHERE key = 'budget_override_<name>';` on the VM
(deploy/verify-governance.sh prints active overrides). Feature availability
note: JSON mode is hard-wired to the OpenAI executor, so the provider's billing
quota is the de-facto ceiling regardless of these caps.

**Retention (the 30-day promise, three layers):** (1) the daily timer's guarded sweep
(`DELETE WHERE last_activity_at < now()-'30 days'` excluding actively-researching rows;
absolute >500-candidate ceiling aborts + CRITICAL email); (2) every project read/
download filters the window and 404s with retention copy; (3) list/create runs a
bounded global sweep (any owner, LIMIT 25) so a dead timer still converges given any
traffic. `last_activity_at` is touched by create, research kick/claim, answer/revise,
confirm, download — never by GET/poll. Disclosed copy (UI + docx disclaimer + the
host-owned /privacy addendum) says "removed from our systems 30 days after your last
activity; encrypted backup copies expire within a further 30 days" — the nightly
pg_dump tail is disclosed, not hidden (set the BACKUP_BUCKET lifecycle ≤35 days).
Kill switch `GOVERNANCE_ENABLED=0`: mutations 503, reads + downloads stay up, the
timer keeps sweeping, the research script + queued kicks stand down.

**Admin review console (`/admin/governance`, 2026-07-23, panel-designed):** the first
host-owned admin page (all others are module wrappers, §5.6). Read-only server
component, `force-dynamic`, self-guarding (`readSession` + `isAdmin` → redirect
`/login`; the layout re-check stays defense-in-depth), reached via
`admin.extraNav` in site.config.ts (module renders host entries after
`enabledPages`). Direct DB reads via `src/lib/governance/admin-db.ts` — a file
deliberately SEPARATE from `db.ts` (whose contract is owner-bound WHERE clauses)
with three invariants, all pinned by tests (`adm32` block in
scripts/governance-tests.ts, which pins `.toSQL()` shapes off the NON-async
exported query builders, no DB connection needed): (1) read-only, no mutation
exported; (2) every project read folds in `retentionCutoff()` exactly like owner
reads, so an expired-but-unswept row never surfaces to the admin either; (3)
content columns NEVER leave Postgres — selects are explicit metadata allowlists;
documents/transcript/research/research-audit/research-progress JSON,
review_summary, next_question_json, open_item_guesses_json, bank_profile_json,
turn_json, changed_sections_json, covered_bank_ids_json, and all style_sample_*
columns are user business content and are not selected, not even inside
`octet_length()`. Page sections: stat tiles (projects on file, owners, research
runs today via `readTodayUsage()` — NEVER `usage[0]`, which is stale on any
quiet day; Tavily month-to-date; failed turns; /governance page views 30d from
`page_visits` — all traffic, not user-attributed, gated on a local replica of
the module's private tracking-disabled check), per-user rollup (staff chip via
`isBudgetExemptEmail` so exempt testing is never read as demand; per-project
`research_runs` is deliberately NOT summed — it is a daily-reset counter and
would mislabel as lifetime), project list (limit 100, status badge covering the
FULL eight-status union incl. `research_failed` as the error state, `live` chip
from claim-liveness horizons coupled to `CAPS.turnStaleMs` and the
claimResearch 5-minute reap, `err` chip for the recorded failed-turn state
`turn_prompt_id` set + `turn_started_at` NULL, deletion countdown derived from
`deletesAt()`), and the attribution-free `governance_usage` 14-day table.
**Deliberate non-feature — no durable per-user event ledger:** the /privacy
governance addendum promises projects are "deleted from our systems 30 days
after your last activity" (backups a further 30), so ANY surviving per-user
governance record — even metadata-only — breaks the letter of published copy,
not just the "Yours, Then Gone" posture. The console's history horizon
therefore EQUALS the public promise, and its copy says so ("a window, not an
archive"). If per-user history is ever required, the order is fixed: amend the
/privacy addendum section in `src/app/privacy/page.tsx` AND the /governance FAQ
line AND review the /work facet copy, deploy the copy, and only then ship a
`governance_events` table (excluding `domain`) with its own pruner. Copy first,
table second.

---

## 6. Database

One local **PostgreSQL** instance, one database **`aiwebsite`** (role `aiwebsite`, password
`aiwebsite` — dev/VM-local default; loopback only). **The site and the brain share this DB**;
brain tables carry the prefix **`brain_`** (`BRAIN_DB_TABLE_PREFIX`).

**Site tables** — drizzle-managed. `src/lib/db/schema.ts` is the single source of truth:
the 12 shared tables are composed from **@aicompany/core's schema factories** (module
architecture.md §6 — `makeUsersTable({...textingUserColumns})`, `makeAuthLogsTable`,
`makePageVisitsTable`, `makeIpOrgsTable`, `makeAdminEmailsTable`, `makeSmsConsentLogsTable`,
`makePhoneVerificationsTable`, `makeSmsPromptEventsTable`, `makeSmsMemoryNoticesTable`,
`makeMemoryDeletionLogsTable`, `makeBlogPostsTable` — added at blog adoption, migration
`0006` — and `makeSmsNoticesTable`, added at the v1.2.1 bump, migration `0007`) plus the
host-owned `contact_submissions`; the composed
shapes are byte-identical to the legacy inline definitions (existing rows are the module's
source shape — module MIGRATIONS.md). `src/lib/db/index.ts` registers the composed set with
the module's client. Migration history is **committed** (introspected no-op baseline at
adoption, diffs forward — replacing the legacy regenerate-on-every-deploy pattern);
setup-vm.sh applies `npm run db:migrate` only:

```sql
users              id uuid PK default gen_random_uuid(), email text NOT NULL UNIQUE,
                   display_name text, auth_provider text NOT NULL, email_domain text NOT NULL,
                   phone text UNIQUE,           -- E.164; set only after code verification (§5.7)
                   phone_verified_at timestamptz, sms_opt_in_at timestamptz,
                   sms_prompt_dismissed_at timestamptz,  -- "Don't ask again" on the prompt card (§5.8)
                   created_at timestamptz default now(), last_login_at timestamptz default now()

sms_prompt_events  id serial PK, user_id uuid NOT NULL REFERENCES users(id),
                   event text NOT NULL,         -- 'shown' | 'clicked' | 'snoozed' | 'dismissed'
                   created_at timestamptz default now()
                   -- append-only prompt-card funnel telemetry (§5.8); NOT consent data

phone_verifications id serial PK, user_id uuid NOT NULL REFERENCES users(id),
                   phone text NOT NULL, code_hash text NOT NULL,   -- SHA-256 of the 6-digit code
                   attempts integer NOT NULL default 0, expires_at timestamptz NOT NULL,
                   consumed_at timestamptz, ip_address inet, created_at timestamptz default now()
                   -- written only by /api/texting/* (§5.7); a row is dead once consumed,
                   -- expired, or attempts > 5; only the newest live row per user is honored

sms_consent_logs   id serial PK, user_id uuid REFERENCES users(id), email text NOT NULL,
                   phone text NOT NULL, sms_opt_in boolean NOT NULL, consent_text text,
                   ip_address inet, user_agent text, page_url text,
                   created_at timestamptz default now()
                   -- TCPA audit trail: append-only, never update/delete; retained for the
                   -- life of the messaging program + 4 years (see /privacy)

sms_memory_notices id serial PK, phone text NOT NULL UNIQUE,   -- E.164
                   sent_at timestamptz default now()
                   -- module factory makeSmsMemoryNoticesTable(); one row per number that
                   -- received the first-contact memory disclosure (§5.2); inserted only
                   -- after the SMS actually sent; deleted by FORGET

sms_notices        id serial PK, phone text NOT NULL,   -- E.164
                   kind text NOT NULL,   -- 'storage_notice' | 'registration_invite'
                   sent_at timestamptz default now(),
                   UNIQUE INDEX sms_notices_phone_kind_idx (phone, kind)
                   -- module factory makeSmsNoticesTable() (v1.2.0, module §5.10); the
                   -- once-ever arbiter for the registration invite (INSERT … ON CONFLICT
                   -- DO NOTHING claims the send); keyed by phone, not user id. The
                   -- 'storage_notice' kind never fires here (memory.enabled). Migration 0007

memory_deletion_logs id serial PK, phone text NOT NULL,
                   requester_ids text NOT NULL,   -- JSON array of erased requester ids
                   deleted_counts text NOT NULL,  -- JSON per-brain-table row counts
                   created_at timestamptz default now()
                   -- proof-of-erasure audit for SMS FORGET (§5.2/§5.9); retained + disclosed

auth_logs          id serial PK, user_id uuid REFERENCES users(id), email text NOT NULL,
                   auth_provider text NOT NULL, ip_address text, user_agent text,
                   success boolean NOT NULL, failure_reason text, created_at timestamptz default now()

contact_submissions id serial PK, name text NOT NULL, email text NOT NULL, company text,
                   phone text, message text NOT NULL, ip_address inet,
                   created_at timestamptz default now()
                   -- no live writer: the contact form + /api/contact were removed in
                   -- commit 1da92d1 (direct channels only); table deliberately retained
                   -- for historical rows and possible future form

page_visits        id serial PK, path text NOT NULL, landing_url text, referrer text,
                   utm_source/utm_medium/utm_campaign/utm_term/utm_content text,
                   ip_address inet, user_agent text, session_hash text,
                   status_code integer default 200, created_at timestamptz default now()
                   -- written only by /api/internal/track (§5.6)

ip_orgs            id serial PK, ip_address inet NOT NULL UNIQUE, asn integer,
                   org_name text, is_isp boolean NOT NULL default false,
                   looked_up_at timestamptz default now()
                   -- MaxMind lookup cache; nulls cached too

admin_emails       id serial PK, to_email text NOT NULL, subject text NOT NULL,
                   body text NOT NULL, session_id text, sent_by text NOT NULL,
                   success boolean NOT NULL, created_at timestamptz default now()
                   -- manual sends from /admin/mailbox; session_id links a reply to its
                   -- brain email session so the thread view can interleave it

blog_posts         id uuid PK default gen_random_uuid(), slug text NOT NULL UNIQUE,
                   type text NOT NULL, title text NOT NULL, meta_description text,
                   body_json text NOT NULL,        -- the ArticleDoc (structured JSON; no HTML)
                   tags text[], primary_keyword text, status text NOT NULL default 'draft',
                   noindex boolean NOT NULL default false, published_at timestamptz,
                   material_hash text, last_material_update_at timestamptz,
                   gate_results/gate_scores text, gate_passed boolean, reviewed_at timestamptz,
                   read_minutes/calendar_week/refresh_count integer, prompt_id text,
                   hero_image/hero_image_alt text, created_at/updated_at timestamptz default now(),
                   prune_step text, prune_step_at timestamptz, prune_redirect_to text
                   -- module makeBlogPostsTable() (§5.11, §19.2); written only by the nightly
                   -- job + /admin/blog actions. Indexes on (status, published_at DESC) and
                   -- (type, status). 32 columns total (29 in migration 0006; the 3 nullable
                   -- prune columns landed in 0007 per module MIGRATIONS v1.1.0 — required
                   -- even though pruning isn't adopted: drizzle selects enumerate columns)
                   -- (hero_image_blur, also in 0006, holds the v1.3.0 blur placeholder)

governance_projects id uuid PK default gen_random_uuid(),
                   user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                   kind text NOT NULL,      -- usage_policy (displayed "AI Acceptable Use Policy (AUP)")|ffiec_aup|nist_ai_rmf|eu_ai_act|iso_42001
                   domain text NOT NULL, status text NOT NULL default 'created',
                   -- created|queued|researching|research_failed|bank_check|drafting|review|done
                   -- (bank_check: paused pre-turn-zero on a qs_ switch card, §5.12 round 20)
                   rev integer NOT NULL default 0,   -- ++ per applied turn; client staleness guard
                   research_started_at/research_heartbeat_at timestamptz,
                   research_runs integer NOT NULL default 0, research_runs_date date,
                   research_progress_json text,      -- step/pct/counts + Tavily checkpoints
                   research_json text,               -- distilled brief, <=9000 chars
                   research_flagged boolean NOT NULL default false,  -- injection screen hit
                   research_audit_json text,         -- brief provenance: facts+sources, screened
                                                     -- suspicion notes, screen-hit slugs (<=20k,
                                                     -- migration 0013, written atomically w/ brief)
                   documents_json text NOT NULL default '[]',   -- [{slug,title,stub,sections[]}]
                   transcript_json text NOT NULL default '[]',
                   covered_bank_ids_json text NOT NULL default '[]',
                   next_question_json text, review_summary text, changed_sections_json text,
                   answers_count integer NOT NULL default 0,
                   acknowledged_at timestamptz NOT NULL default now(), -- UPL ack record (§5.12)
                   style_sample_name/style_sample_text text,  -- sample-policy upload (§5.12,
                   -- migration 0010): extracted text only, <=20k chars, deletes with the row
                   style_sample_header/style_sample_footer text,  -- sample letterhead (§5.12
                   -- round 17b, migration 0016): page header/footer text captured at upload
                   -- from .docx parts ({{PAGE}}/{{PAGES}}/{{TITLE}} tokens); "" = scanned,
                   -- nothing found; NULL = pre-17 sample or non-docx; render-only, never
                   -- prompted; cleared with the sample
                   style_sample_debt text,  -- reformat-debt nonce (§5.12 round 16, migration
                   -- 0014): non-NULL = sample changed since the last COMPLETE reformat run;
                   -- set by style-sample POST (only when >=1 drafted section), cleared by
                   -- DELETE and by the restyle run's final pass (token-equality CASE in
                   -- applyTurnWrite fences it against mid-run replacements)
                   open_item_guesses_json text,  -- marker best-guess store (§5.12, migration
                   bank_profile_json text,           -- FFIEC: LBR row + evidence + switch decision
                                                     -- + asset tier (migration 0017, lenient-parsed)
                   -- 0015): {marker key: guesses[]}, model-authored, pruned to live markers
                   -- on every turn write; null = no chips. Own cold column BY DESIGN so
                   -- guesses can never tip documents_json over its 150 KB write cap
                   turn_prompt_id/turn_attempt_id/turn_json text, turn_started_at timestamptz,
                   -- async answer-turn claim (§5.12, migration 0012): started_at set = running
                   -- (stale past 240 s = orphan, lazily reaped by the next claim); started_at
                   -- NULL + prompt_id set = failed, turn_json = {questionId,error,failedAt};
                   -- attempt_id = per-claim fence nonce for worker writes. The answer TEXT is
                   -- never stored here (sessionStorage draft is the client's source of truth)
                   created_at/updated_at/last_activity_at timestamptz NOT NULL default now()
                   -- §5.12. Migration 0009; indexes on user_id + last_activity_at.
                   -- Hard-DELETEd 30 days after last_activity_at by the governance timer,
                   -- the request path, and the bounded list/create sweep — NOT the module
                   -- retention sweeper. App-enforced ceilings: documents 150 KB,
                   -- transcript 200 KB (rejected before write)

governance_usage   day date PK, tavily_calls/brain_calls/research_runs integer NOT NULL default 0
                   -- §5.12 daily budget ledger: out-of-process so caps survive PM2 restarts
                   -- and bind the detached research script; pruned at 90 days

governance_meta    key text PK, value text NOT NULL, updated_at timestamptz NOT NULL default now()
                   -- request-path stamps/throttles (governance_sweep_last_run canary,
                   -- budget_alert_* alert throttles, troy_reject_* WARN throttles),
                   -- budget_override_* runtime caps (the Troy approval loop; clamped to
                   -- BUDGET_CEILINGS), troy_msg_* replay-dedupe keys (pruned 14 d),
                   -- budget_audit_* change records (pruned 180 d).
                   -- Single-writer split: data/governance-standards/state.json belongs to
                   -- the timer script ALONE; the web process writes here

blog_hero_images   slug text PK, data bytea NOT NULL, mime text default 'image/webp',
                   content_hash text, updated_at timestamptz default now()
                   -- module makeBlogHeroImagesTable() (§5.11 v1.3.0, module §19.26,
                   -- migration 0008); ~100KB webp per post, written by the nightly hero
                   -- hook / backfill CLI, served by /blog/hero/[slug] (bytes deliberately
                   -- outside blog_posts so article selects stay light)
```

**Brain tables** — created at runtime by brain-api's own migration array on first boot
(~40 tables: `brain_messages`, `brain_memories`, `brain_goals`, `brain_usage_events`,
`brain_phone_calls`, …; NOTE the brain's prefix translator misses `archive_search_index`,
which is therefore UNPREFIXED in Postgres). Not managed by drizzle; never migrate them from
the parent repo. Site-side **writes** (all via @aicompany/core) are the enumerated set in §5.9: the seed SQL +
nightly crawl upsert into `brain_memories` (columns used: `id, requester_id, group_id,
scope, kind, key, value, importance, salience, source_type, created_at, updated_at`), the
verify-time requester migration (`brain_memories`, `brain_messages`,
`brain_conversation_turns`), the FORGET erasure (the §5.9 table list), and the shared-scope
sweep (`brain_memories.valid_until`). **Re-audit that list on every brain submodule bump**
— a new content-bearing brain table will NOT be covered by FORGET until added. The admin
console additionally **reads** `brain_messages`, `brain_usage_events` and
`brain_phone_calls` via the module's `db/brain-read` (§5.6) — raw SQL, resilient to the
tables not existing yet.

**Persona seed** — `deploy/seed-persona-memories.sql`, **generated at deploy time** from
site.config.ts by the module's `scripts/generate-seed-sql.ts` (derived output, not
hand-maintained — the legacy hand-written `deploy/seed-tron-memories.sql` is superseded):
idempotent upsert (fixed ids, `ON CONFLICT (id) DO UPDATE`) of public-scope rows (persona
identity, scope, company/services/results/AI/contact facts). Applied by `setup-vm.sh` on
every deploy *after* brain-api is healthy (tables must exist). These rows are the persona's
evergreen identity on all channels and — critically — **the entire knowledge base for the voice
channel** (realtime voice sessions inject visible memories, not the prompt doc). The nightly
crawl never touches them (it only replaces `source_type='site_crawl'` rows).

---

## 7. The brain contract (what the site depends on)

The brain (submodule `packages/brain` ← `https://github.com/adampr/xldev.git`, pinned at
tag `v1.97` — the v1.93 line (added `invocation.promptProfile` `'full'|'lean'` and
reader-determinism knobs) + the Issue #684 router-availability fix (v1.94) + **deterministic
JSON mode** (Issue #688, v1.95): an envelope with `response_format: {type:'json_object'}`
short-circuits the thinking pipeline to one direct completion so callers actually get JSON
+ the Issue #689 `BRAIN_DB_TABLE_PREFIX` fix (v1.96) + **dynamic multi-provider model
routing** (Issues #692–#696, v1.97): unified registry (anthropic ids routable —
`/v1/model-routing` rows may now say `provider:"anthropic"`), router v2 behind `BRAIN_ROUTER`
(legacy default — no behavior change until flipped), model kill switch + telemetry
(additive auto-migrations 45/46).
The blog engine (§5.11) depends on v1.95+; the persona channels' envelopes are unchanged and
`promptProfile`/`temperature` remain available-but-not-yet-sent) is a
generic "conversation-first, memory-bearing" engine. **The Tron Netter persona lives entirely
in the parent repo** — the brain receives it per-request via `brainIdentity` + a system message.
Rebuild the brain from its own canonical doc; the site needs only this contract:

### Endpoints consumed

| Endpoint | Auth | Used for |
|---|---|---|
| `POST /v1/chat/completions` | Bearer | all three site channels |
| `GET /v1/tools` | Bearer | enumerate tool names → send back as `disabledTools` |
| `GET /health` | none | readiness (`{ok:true, service:"brain-api", version}`), PM2/watchdog/deploy checks |
| `GET /v1/model-routing` | Bearer | (Issue #684 fix, upstream #686, in v1.94+) concrete model id per pipeline task + `plannerEffectiveModel`; consumed by `scripts/ai-provider-health.mjs` (§9.6) to probe routed ids before visitors hit them |
| `POST|GET /twilio/*` + WS `/twilio/ws` | Twilio signature | voice + carrier SMS — Twilio calls these directly through nginx; the site never does |

### Request envelope (fields this site sends)

```jsonc
{
  "sessionId": "tron_…| sms-+1312…| email2-user@x.com-<thread>",  // channel-stable → threading;
                                          // the brain replays history by sessionId with NO
                                          // requester check — hence the chat route's tron_
                                          // namespace validation (§5.1)
  "promptId": "tron_<base36ts>_<rand>",  // MANDATORY (400 without); idempotency key —
                                          // a retry with the same (sessionId,promptId) attaches
                                          // to the in-flight stream or replays the cached result
  "messages": [{"role":"system","content":"<persona+knowledge>"}, …visitor msgs],
  "brainIdentity": { "brainName":"Tron Netter", "personality":…, "purpose":…, … },
  // NO groupName — deliberately absent on every Tron envelope (§5.9): extraction candidates
  // can carry scope 'private_to_group' past the envelope's privacyScope; without a groupId
  // the brain demotes them to private_to_requester.
  "memoryMode": "store_persistent" /* memory-bearing turns (§5.9) */ | "do_not_store",
  "privacyScope": "private_to_requester", // whenever a requester is sent
  "requester": {"requesterId": "<E.164|user:<uuid>|email:addr>", "email": "…"},  // §5.9 identity table
  "markdownMode": "html" /* chat */ | "strip" /* sms, email */,
  "disabledTools": ["memory_lookup","web_search",…],  // full list from GET /v1/tools
  "invocation": { "maxOrchestratorPhase": 1 }  // ALL channels: clamp to direct_answer.
      // Tron has no tools, so think_harder/plan_execute escalations only add
      // 30-60 s latency + world-knowledge answers, and escalation-only pipeline
      // failures (e.g. brain Issue #684's unavailable-model 404 in the
      // plan_execute verifier) surfaced as the SMS "hit a snag" apology.
}
```

Non-streaming response is OpenAI-compatible; the site reads `choices[0].message.content`.
With `Accept: application/x-ndjson` the brain streams NDJSON events (each tagged with
`promptId`): `state`, `token{text}`, `phase_progress`, `answer_revised{text}`, `result{…full
payload}`, `error`. The site's chat route filters this down to the widget's 4-event protocol (§5.1).

### Brain runtime facts that matter to this deployment

- Express 5, run as TypeScript directly via the submodule's own `tsx` — **no build step**.
- Storage backend is selectable; the v1.99 line makes postgres the default per the
  fleet no-SQLite directive 2026-07-16. History: v1.99.1 was ROLLED BACK on this host
  the same day (its `widenPgIntegerColumns` boot migration failed on views depending
  on altered columns — `test_ui_issue_reports` / `audio_related` — crash-looping
  brain-api in prod); v1.99.2 made the widen pass best-effort (view-blocked ALTER
  warns loudly and boot continues) and was re-adopted. **Current submodule pin:
  v1.107 (6440513, 2026-07-24, hotfix branch off v1.106 02cc6ca)** — xldev
  Issue #718: the vendor PG adapter reconnects on server-side connection loss
  and brain-api `/health` deep-checks the DB (503 + `db:"error"`). Root cause
  of the 2026-07-24 chat outage on THIS host (every turn = one instant
  `{"type":"error"}` NDJSON event while `/health` stayed 200): brain-api's
  single sync pg-native connection died after boot with no reconnect path; no
  dependency or registry churn vs 02cc6ca. Previous pin v1.106 (02cc6ca,
  2026-07-22) carried automatic model-registry id-drift resolution
  (rename auto-repoint w/ alias preservation, alias-aware kill switch,
  retirement lifecycle, heads-baseline anti-silent-flip gate) + gpt-5.6-terra/
  -sol and grok-4.5 routable (xldev #715/#716); pin history v1.102 d4f34eb →
  v1.103 f13d6be → v1.105 60df5d5 → v1.106 02cc6ca → v1.107 6440513. v1.102 brought
  per-call panel forcing (`invocation.panelMode`,
  #701) + JSON-native forced panel (#703: json_object turns run draft → cross-lab
  refute → one revision; machine-checkable `thinking.panel` receipt). Consumed here
  by the blog engine: `@aicompany/core` v1.10.0 (master lineage — carries v1.9.0
  §5.3 blocked-sender forwards, the v1.8.2 duplicate-tolerant session read, and the
  v1.8.1 chat-widget `aic-chat-*` scoping this host was branch-pinned to at 1fb62f1)
  with `blog.quality.panel: "on"` in site.config.ts forcing the cross-lab refuter on
  every article-authoring call (owner directive 2026-07-17); a non-convened panel
  publishes noindexed until a panel-clean pass; chat envelopes keep
  `maxOrchestratorPhase: 1`. v1.10.0 adds the §19.5 gate-failure escalation ladder,
  opted in here via `blog.quality.maxRegenerates: 1` (owner directive 2026-07-22 —
  "resolve WARNs in-run"): a rubric-only failure skips the (style-incapable)
  data-only repair and goes straight to ONE feedback-carrying fresh-writer
  regenerate (failed gates, verbatim issues, rubric scores vs thresholds, reviewer
  notes, full-rewrite marker), which re-gates and adopts on pass (published
  INDEXED, outcome OK) or strictly-better; the terminal case still publishes
  noindexed + WARN. Report lines: `generate-repair: skipped (rubric-only …` /
  `generate-regenerate: fresh draft passed all gates — resolved in-run` / `… not
  better …` / `… skipped — call budget insufficient`. Safe here vs the shared
  12-call nightly ceiling because Phase B refresh is disabled on this host.
  Previous pin v1.100 (dae30ad) — default-off panel program Stage 0+A, behavior
  byte-identical with BRAIN_PANEL unset; adoption caveat: a claude-*/grok-*/gemini-*
  model pin without its provider key now fails loudly (ProviderKeyMissingError)
  instead of silently misrouting to OpenAI. Cross-lab prerequisite for the blog
  panel: both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` present in the VM `.env`. This deployment runs
  `BRAIN_DB_BACKEND=postgres` against the shared DB with prefix `brain_` (Postgres
  duck-types the sync better-sqlite3 API via `pg-native` → needs `libpq-dev` + build tools
  at `npm ci` time). Since v1.99.1 the thinking-debug store also lives in Postgres
  (`brain_thinking_passes`) — the old `~/software-brain-data/thinking-debug.sqlite` on the
  VM is retired (renamed `.retired-2026-07-16`), and pre-v1.99 int4 columns are widened to
  BIGINT automatically at boot.
- Env is loaded from `SOFTWARE_BRAIN_ENV_PATH` (prod: `/var/www/aiwebsite/.env`) — one shared
  `.env` for site + brain.
- Embeddings are local ONNX (`nomic-ai/nomic-embed-text-v1.5`, 768-d, via
  `@huggingface/transformers`) — no embedding API cost or key.
- Default models (env-overridable): chat `gpt-5.4-mini` (`BRAIN_FIRST_PASS_MODEL` required for
  snappy first tokens), executor `gpt-5.4`, memory extraction `gpt-5-mini`, critic
  `claude-opus-4-7`, STT Deepgram `nova-3`, TTS `tts-1`, realtime voice xAI
  `grok-voice-think-fast-1.0` (`BRAIN_AUDIO_MODE=xai_realtime`).
- skills-host (:3213) is the brain's tool-execution sidecar (`web_search`, `calculator`, …,
  each `POST /skills/<name>`); required by brain-api even though public-persona tools are disabled.
- **Memory model the site depends on (§5.9 builds on these):** recall predicate is
  `scope='public' OR (scope='private_to_requester' AND requester_id = :requesterId) OR
  (scope='private_to_group' AND group_id = :groupId)` with `valid_until IS NULL` — exact
  string match on requester_id. Fact extraction/writes happen ONLY when
  `memoryMode='store_persistent'`; conversation turns (`brain_messages`,
  `brain_conversation_turns`) are stored **regardless of memoryMode** whenever a requester is
  present, and replayed by sessionId (no requester check) + cross-session by requester_id.
  Extraction candidates carry their own scope which **overrides** the envelope's privacyScope
  (public-scope escapes ⇒ the §5.9 sweep). Soft-delete convention is `valid_until = <ISO now>`.
  Inbound **voice** keys memory recall by the caller's E.164 and never writes facts (realtime
  persona forces do_not_store) — this is what makes the verified phone the canonical id.
- The brain's Postgres adapter is ONE synchronous `pg-native` connection — every brain query
  blocks its whole event loop, so site-side transactions on brain tables must stay short
  (§5.9 FORGET collects sessions before BEGIN).

---

## 8. Knowledge pipeline (nightly crawl)

The module's crawler `packages/aicompany/scripts/refresh-knowledge.mjs` (module
architecture.md §8) — plain Node ESM, only dep `postgres` (dynamic import). It never
imports TypeScript: it reads the JSON config snapshot `data/aiwebsite-config.json`
(re-rendered by the module's `scripts/config-json.ts` at deploy time and by the timer's
`ExecStartPre`), whose values come from site.config.ts `knowledge.*`/`persona.*` — ported
verbatim from the legacy host crawler, so the behavior below is unchanged. The legacy
`scripts/refresh-tron-knowledge.mjs` remains in the repo but is no longer wired into
deploy.

- **Crawl**: 100 % of HTML pages on `https://xl.net` and `https://ai.xl.net`. Seeds from each
  origin's `/sitemap.xml` (follows sitemap indexes, ≤20 children) **plus** a full same-host link
  walk. 4 workers, 250 ms delay each, 20 s fetch timeout, cap `knowledge.maxPagesPerSite`=1000
  (loudly reported if hit), UA `TronNetterKnowledgeBot/1.0`. URL normalization: https, strip
  www/query/fragment/trailing slash; assets skipped by extension; pages deduped by SHA-1 of
  extracted text. HTML→text strips head/script/style/nav/header/footer/form. When
  `BLOG_ENABLED=1`, the module skips the `blog.types[].urlPrefix` paths **entirely**
  (`blogUrlPrefixes` in the `data/aiwebsite-config.json` snapshot, §19.9): the blog job
  already feeds Tron its own `data/<slug>-articles-index.md`, so re-crawling the articles
  would double-count AI-authored copy back into the knowledge doc.
- **Three sinks, REPLACE semantics (never append)**:
  1. `brain_memories` `source_type='site_crawl'` — one ≤500-char summary row per page,
     upsert current + delete stale, in one transaction (via `BRAIN_POSTGRES_URL` ∥
     `DATABASE_URL`). Core pages importance 0.9, archives 0.6. Feeds all channels incl. voice.
     Followed by the **nightly poisoning-sweep backstop** (§5.9): soft-invalidate shared-scope
     rows with `source_type NOT IN ('seed','site_crawl','blog_article')`; swept count > 0 → warning line in
     the report email.
  2. `data/tron-netter-knowledge.md` (`persona.knowledgeFile`) — the prompt doc, budget
     175 000 chars (`knowledge.promptDocMaxChars`): core-first ordering
     (`knowledge.coreOriginFirst` ai.xl.net → service pages → archives), full text for pages
     that fit + compact index for the rest. Hot-reloaded on mtime by the module's
     system-prompt builder.
  3. `data/tron-netter-knowledge-full.md` — complete crawl, audit only.
  Files written atomically (tmp + rename, 0644).
- **Safety**: aborts and keeps yesterday's knowledge if any site yields 0 pages or combined
  text <5000 chars → FAILED email.
- **Report email** via Resend from `XL.net AI Knowledge Refresh <noreply@ai.xl.net>` to
  `KNOWLEDGE_NOTIFY_EMAIL` ∥ `ADMIN_EMAIL` ∥ `oversight.alertEmail` (adam@xl.net): duration, pages/words/KB per site,
  sink outcomes, warnings, ≤15 fetch errors; subject OK / PARTIAL (memory sink failed) / FAILED.
- **Schedule**: systemd timer `aiwebsite-knowledge.timer` (`OnCalendar=*-*-* 08:00:00 UTC`
  = 3 am Chicago, `Persistent=true`) → `/var/log/aiwebsite-knowledge.log`; also run once
  per deploy with `--no-email`.

### 8.1 Governance standards pipeline (quarterly, host-owned)

`scripts/governance-standards-refresh.ts`, run daily at 04:30 UTC by the
`aiwebsite-governance` timer (§9.7; installed by `deploy/post-install.sh`, NOT a
rendered template). Daily duties always run (even with `GOVERNANCE_ENABLED=0` — the
§5.12 retention promise outlives the kill switch): guarded 30-day retention sweep,
stale-research reaper (heartbeat >15 min → `queued`), kick ≤2 queued projects, prune
`governance_usage` >90 d, stamp `governance_meta.governance_sweep_last_run`. Exit 1
(→ the OnFailure alert unit emails `[aiwebsite] CRITICAL Governance timer unit
FAILED`) is reserved for cleanup failures; standards failures WARN by email and exit 0.

**Standards watch + deep research** (self-gated): per standard, fetch 2-3 watch URLs
with a browser UA (NIST program page + AIRC; artificialintelligenceact.eu timeline +
home + the EUR-Lex 2024/1689 page; both iso.org catalogue URLs with a Tavily-search
fallback because iso.org 403s scripted fetchers), hash normalized text, extract
version markers (NIST pub ids / AI-Act application dates + "digital omnibus" / ISO
`42001:YYYY` + stage codes). Deep research triggers on: bootstrap (no doc) ∥
`lastDeepResearch ≥ refreshDays` (per-StandardDef; default 90, **7 for `ffiec-ai`**
— FFIEC-relevant issuances move faster and SR 26-2 explicitly deferred AI
provisions to forthcoming guidance) ∥ watch-hash change judged substantive by a mini
brain call (filters page churn). The `ffiec-ai` def has `watchUrls: []` BY DESIGN
(ithandbook.ffiec.gov CAPTCHA-403s every direct fetcher we have, verified
2026-07-21: curl, browser UA, headless chromium, Tavily /extract, and the
`/rss-whatsnew` feed URL itself). Its preferred change signal is the **Feedly
public-API mirror** of the What's New feed (`feedlyStreamId:
"feed/http://ithandbook.ffiec.gov/rss-whatsnew.aspx"` — Feedly's pollers are
allow-listed by FFIEC; `GET cloud.feedly.com/v3/streams/contents?streamId=…`,
unauthenticated). `feedlyMirrorLines()` (research.ts, test-pinned) reduces the
body to stable `YYYY-MM-DD Title` lines — volatile engagement/crawl fields never
reach the watch hash, malformed bodies read as a dark leg. The feed is
announcements-only (items years apart), so a hash change is a precise
booklet-revision signal. Feedly is a courtesy endpoint with no SLA, so the
domain-restricted Tavily fallback (`watchFallbackDomains`, `include_domains`
passthrough in `tavilySearch`) stays behind it as the `okCount === 0` backstop
(also: a healthy mirror saves that daily Tavily call); either leg counts as ok,
so the fail-streak alarm arms only when both are dark. Its 10-query bank includes two
ithandbook-domain-restricted queries and one `maxResults:10` open news sweep (the
owner's top-10 review — its articles enter the ranked SOURCE POOL the author calls
read, deliberately NOT a watch leg: a daily news hash would thrash the substantive
classifier). Per-def `staleWarnDays/staleCritDays` (17/28 for ffiec) scale the
staleness alarms; `inCrossDigest:false` keeps FFIEC content out of the AUP digest;
per-def `extraCiteCapture` appends SR/Circular/FIL/FIN/12-CFR shapes to the
citation capture for the ffiec def ONLY (other standards' docs stay
byte-identical, pinned), and its `validCitation` also accepts `NIST AI` ids. A new
`--only=<slug>` flag (combined with `--force-research`) bootstraps one standard's
knowledge without re-researching the rest. The timer also refreshes the
`data/lbr/` bank-list cache weekly (WARN on failure, stale cache stays served). Per triggered standard: ~8 advanced Tavily queries, source
tiering (tier1 nist.gov/eur-lex/europa.eu/iso.org/artificialintelligenceact.eu >
tier2 iapp/.gov/.edu > tier3 corroborate-or-hedge), then the reference doc is
authored **per skeleton section** (Overview / Key obligations / Document set
blueprint / Question bank seeds / Glossary; ~5 JSON calls — one 7000-word JSON
completion is fragile with no max_tokens control), **citation-validated against
hardcoded allowlists** (EU Articles 1-113 + Annexes I-XIII; ISO A.2-A.10.x + clauses
4-10; NIST GV/MP/MS/MG ids + `NIST AI 600-1`; unverifiable citations are stripped and
counted), injection-screened, Sources section host-assembled from the ranked URLs,
atomic tmp+rename to `data/governance-standards/<slug>.md` (+ `.prev` kept). Failure
= keep yesterday's doc, WARN. `cross-standard-digest.md` (the AUP (`usage_policy`) prompt
slice) is host-assembled from the three docs' Key-obligations sections — no extra
author call. `src/lib/governance/standards.ts` serves mtime-cached slices to the
§5.12 prompts, with hardcoded conservative fallbacks during the bootstrap window.

**Seed memories:** after research, 5 fixed-id `source_type='seed'` public rows
(`seed-gov-{nist-ai-rmf,eu-ai-act,iso-42001,ffiec-ai,feature}`) are upserted so Tron is
conversant on every channel including voice. Values are **fixed host-authored
templates** — only bounded fields (date, sanitized version markers ≤120 chars) come
from research; free web text NEVER enters the shared persona (public rows reach every
visitor; the §5.9 allowlist already sanctions 'seed'). Each row carries the
"orientation only, not legal advice" hedge.

**Alert grammar** (throttled 1/24 h per condition in state.json; no daily success
mail): OK report on research runs (diffs, citation strips, MTD Tavily);
`WARN Governance change-detection degraded` after 7 consecutive watch-fetch failure
days; `WARN/CRITICAL Governance standard stale` at >100 d/>120 d;
`WARN Governance Tavily monthly usage high` past `GOVERNANCE_TAVILY_MONTHLY_WARN`;
`CRITICAL Governance project cleanup FAILED` on sweep abort. The dead-timer story:
post-install re-enables the timer every deploy; retention is also request-path
enforced (§5.12); `POST /api/governance/projects` reads the sweep stamp and can WARN
when it goes stale.

---

## 9. Deployment & operations

Everything under `deploy/` except `site-deploy.env`, the runbooks, and the generated seed
SQL is **rendered from @aicompany/core's `deploy/templates/*`** (module architecture.md §9)
by `node packages/aicompany/deploy/render.mjs`, which substitutes the values in
`deploy/site-deploy.env` (SLUG `aiwebsite`, DOMAIN `ai.xl.net`, APP_DIR
`/var/www/aiwebsite`, ports 3000/3211/3213, tunnel `aiwebsite`, alert to adam@xl.net,
transport + retention windows). Every rendered file carries a stamp line
`# aicompany-template: <name>.tpl@<sha256>`; **deploy.sh verifies the stamps against the
current submodule's templates and fails on drift** — re-render and commit after any module
bump that touches templates (module MIGRATIONS.md names those). Rendered files are
committed; edit the template (module repo) or `site-deploy.env`, never the output.

### 9.1 Deploy flow (`deploy/deploy.sh`, run from the dev box)

1. **Template-stamp drift gate** (above) — aborts before touching the VM.
2. Transport per `site-deploy.env`: **`ssh-key`** since 2026-07-12 (dev-box key
   `~/.ssh/id_ed25519` authorized on the VM; key path from `AIWEBSITE_SSH_KEY` in
   `.env`, else `SSH_KEY_PATH`; `AIWEBSITE_SSH_IP`/`AIWEBSITE_USER` read **literally**
   from `.env`, never sourced). The legacy `sshpass` transport (`AIWEBSITE_PW` +
   explicit `--allow-sshpass` flag) remains only as a break-glass fallback.
   (A `gcloud-iap` variant exists for GCP.)
3. `rsync -az --delete` repo → `/var/www/aiwebsite`, **excluding** `.git`, `node_modules`,
   `.next`, brain caches, `.env`, `/data/` (VM-generated knowledge must survive the delete),
   and — v1.13.0 — the staged-deploy `*.old`/`*.new` generation dirs (the VM-side rollback
   set must survive the delete too). deploy.sh also touches the deploy↔watchdog marker
   BEFORE the sync so a watchdog staged rebuild can never stage half-synced sources.
4. rsync the production `.env` separately; ship `data/GeoLite2-ASN.mmdb` explicitly if
   present locally (it lives inside the excluded `/data/`); ship
   `~/.cloudflared/aiwebsite-tunnel.json` → `/etc/cloudflared/` (0600) if present.
5. SSH → run `deploy/setup-vm.sh` (below).
6. Verify `127.0.0.1:3000/api/health`, `127.0.0.1:3211/health`, then public
   `https://ai.xl.net/api/health`.

### 9.2 VM provisioning (`deploy/setup-vm.sh`, idempotent)

APT `build-essential python3 libpq-dev pkg-config jq rsync logrotate` → Node 22
(nodesource) + PM2 (+ `pm2-logrotate` 10 M/retain 7) → PostgreSQL (create role+db
`aiwebsite`, guarded; `max_wal_size=256MB`) → nginx config (below) → **staged
build pipeline (module v1.13.0, `deploy/stage-build.sh`)**: everything mutating
runs in the sibling `/var/www/aiwebsite.stage` tree under a pipeline-scoped
fd-201 flock while the OLD app keeps serving — heal → prepare (rsync live→stage;
6144 MB disk floor) → `npm ci --include=dev` (site **and** `packages/brain`, in
stage) → **host post-install hook** (`deploy/post-install.sh` — host-owned, not
template-rendered; cwd = STAGE since v1.13.0: idempotently installs the
`aiwebsite-governance.{service,timer}` + OnFailure alert unit BY ABSOLUTE LIVE
PATHS — compliant with the v1.13.0 env/live-path contract; §8.1/§9.7) → re-copy
the live `.env` into stage → heap-capped `next build` (in stage; `next build`
CLEARS distDir at start, which is why it must never run in the live tree —
the pre-v1.13.0 claim that output "swaps atomically" was false) →
`verify-relocatable` → `db:migrate` (from stage against the live DB, committed
history — AFTER the build so a failed build leaves the DB untouched) →
**`npm run config:check`** (AFTER migrate — its drift gate fails on
committed-but-unapplied migrations; **gates the CUTOVER**: a bad config aborts
with the old build serving) → generate `deploy/seed-persona-memories.sql` from
site.config.ts (§6) → **journaled renames-only cutover** (flips `node_modules`,
`packages/brain/node_modules`, `.next`; N−1 kept as `*.old` for rollback) →
`pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save && pm2
startup systemd` (`--update-env`: plain reload keeps the env captured at
process creation, so a deploy that only changed `.env` left the site running
with stale governance caps for hours, 2026-07-16; upstreamed v1.6.1) → **120 s
health gate** (site body `"status":"ok"`, brain-api `/health`, pm2-online ×2;
failure auto-rolls the flip back and the deploy FAILS with the OLD build
serving; success prints `>>> CUTOVER COMPLETE`) → wait ≤60 s for brain
`/health` → `psql -f deploy/seed-persona-memories.sql` → render
`data/aiwebsite-config.json` + install the **five systemd timers** (§9.7) →
initial crawl `--no-email` → `setup-cloudflared.sh` → install watchdog + cron
supervisor and (re)start it. Successful-deploy downtime = the pm2 fork restart
(~3–10 s); every pre-cutover failure leaves the old app serving. Manual
rollback: `cd /var/www/aiwebsite && bash deploy/stage-build.sh rollback && pm2
restart aiwebsite brain-api skills-host --update-env`.

### 9.3 PM2 processes (`deploy/ecosystem.config.cjs` + `deploy/pm2-start.cjs`)

All fork mode, 1 instance, autorestart; the config parses `/var/www/aiwebsite/.env` literally
and injects it into each app.

| name | script | cwd | port | notes |
|---|---|---|---|---|
| `aiwebsite` | `deploy/pm2-start.cjs` | repo root | 3000 | wrapper spawns `next start -p 3000`, polls `/api/health` every 500 ms ≤30 s, signals PM2 `ready` (`wait_ready`); forwards SIGINT/SIGTERM. Fork mode is deliberate — cluster mode killed the wrapper silently. 1 G mem-restart |
| `brain-api` | `packages/brain/node_modules/.bin/tsx apps/brain-api/src/server.ts` | `packages/brain` | 3211 | `BRAIN_DB_BACKEND=postgres`, `BRAIN_DB_TABLE_PREFIX=brain_`, `SOFTWARE_BRAIN_ENV_PATH=/var/www/aiwebsite/.env`. 768 M mem-restart |
| `skills-host` | `…/tsx apps/skills-host/src/server.ts` | `packages/brain` | 3213 | `AUTOMATION_SECRET`, `NEXTJS_BASE_URL=http://127.0.0.1:3000`. 256 M |

### 9.4 nginx (`deploy/nginx.conf`)

Single server block, **listen 127.0.0.1:80 only** (cloudflared is the sole ingress),
`server_name ai.xl.net`. TLS terminates at Cloudflare; real client IP recovered from
`CF-Connecting-IP` (`set_real_ip_from 127.0.0.1`). Routes: `/` → :3000 (WebSocket upgrade,
120 s timeouts) · `/_next/static` → :3000 (365 d immutable cache) · `/brain/twilio/` →
`:3211/twilio/` (3600 s timeouts for call WebSockets). Security headers: X-Frame-Options
SAMEORIGIN, nosniff, Referrer-Policy strict-origin-when-cross-origin, HSTS 1 y
includeSubDomains. Logs `/var/log/nginx/aiwebsite.{access,error}.log`.

### 9.5 Cloudflare tunnel (`deploy/setup-cloudflared.sh`)

Tunnel **`aiwebsite`**, ID **`8dbfd62e-eb42-4589-8b76-d1edc77cd018`**. Pre-provisioned mode
reads `/etc/cloudflared/aiwebsite-tunnel.json` (shipped by deploy.sh — no browser login);
fresh mode does `tunnel login/create/route dns`. `/etc/cloudflared/config.yml` ingress:
`ai.xl.net → http://127.0.0.1:80`, fallback 404. systemd service, enabled.

**DNS is a human step** (the dev box's Cloudflare cert is scoped to the itsupportchicago.net
zone and cannot write xl.net): CNAME `ai` → `8dbfd62e-….cfargotunnel.com`, **Proxied**.

### 9.6 Watchdog (`deploy/watchdog.sh` + `watchdog-cron.sh`)

- Persistent root loop, 60 s interval, PID `/var/run/aiwebsite-watchdog.pid`, log
  `/var/log/aiwebsite-watchdog.log`; executes pm2/npm as the app owner via `runuser`.
- Each pass: `pg_isready`:5432 → restart postgresql · nginx active → restart · cloudflared
  active → restart · `:3211/health` `"ok":true` → `pm2 restart brain-api` · `:3213/health` →
  restart skills-host · `:3000/api/health` `"status":"ok"` → restart aiwebsite; plus
  **freshness checks**: backup heartbeat `/var/lib/aiwebsite/last-backup-ok`, the
  knowledge doc's mtime (path from the `data/aiwebsite-config.json` snapshot), and — when
  `BLOG_ENABLED=1` — the blog heartbeat `data/blog-last-run` (§5.11) — any >26 h old →
  alert — plus (v1.1.0 template) the digest state file `data/blog-digest-last` at its own
  35-day threshold (blog-digest.ts stamps it on EVERY exit path incl. OK-skips, so stale
  means the daily digest timer is dead, not "not due").
- Every 5th pass: renders `/` and `/login`; on 5xx / "application error" /
  NEXT_NOT_FOUND / timeout → **staged rebuild** (module v1.13.0: full-pipeline flock on
  `/var/www/aiwebsite.stage/.lock`; deps hardlink-cloned from the LIVE `node_modules`
  via `cp -al` — no npm; `BUILD_HEAP_MB`-capped build; `config:check` drift gate;
  `.next`-only cutover-repair that never consumes the deploy's `*.old` rollback set;
  a lock-held collision with a deploy is a benign rc-3 skip) + restart + re-verify.
  A failed repair leaves the live tree untouched.
- Alerts via Resend to adam@xl.net from `ai.xl.net Watchdog <noreply@ai.xl.net>`, throttled
  1 email / unique issue / 24 h (`/tmp/aiwebsite-watchdog-throttle`); every subject starts
  **`[aiwebsite] <SEVERITY>`** (module §9.5 multi-site alert grammar).
- `watchdog-cron.sh` (root cron `*/5 * * * *` — the only remaining crontab entry)
  relaunches the loop if its PID is dead (verifies `/proc/PID/cmdline`).
- **AI-provider checks are no longer part of the rendered watchdog** (the module template
  has no equivalent — an adoption regression to restore or schedule separately).
  `scripts/ai-provider-health.mjs` remains standalone: auth-probes every configured AI key
  (OpenAI, Anthropic, xAI, Gemini, Deepgram, Tavily), fetches the brain's
  `GET /v1/model-routing` and fires a 1-token completion at every unique routed model id —
  catching the "hit a snag" class and key expiry/quota before visitors do.
  `node scripts/ai-provider-health.mjs [--env path]`, exit 0/1.

### 9.7 Scheduled work — systemd timers (`Persistent=true`), not cron

Installed/enabled by setup-vm.sh — except `aiwebsite-governance`, installed by the host
post-install hook (§9.2); scripts installed to `/usr/local/bin/aiwebsite-*`;
verify with `systemctl list-timers 'aiwebsite-*'` (all 8 — the blog + blog-digest timers
are installed only when `BLOG_ENABLED=1`):

| Timer | Schedule (UTC) | Does |
|---|---|---|
| `aiwebsite-knowledge` | daily 08:00 | nightly crawl (§8); `ExecStartPre` re-renders `data/aiwebsite-config.json` |
| `aiwebsite-blog` | daily 09:30 + ~4484 s slug jitter (≈10:44) | nightly AI-news post (§5.11): `packages/aicompany/scripts/blog-nightly.ts` via the app's own tsx. `Type=oneshot`, `After=aiwebsite-knowledge.service` (ordered behind the 08:00 crawl); logs `/var/log/aiwebsite-blog.log`. Gated on `BLOG_ENABLED=1` |
| `aiwebsite-blog-digest` | daily 14:00 (`BLOG_DIGEST_ONCALENDAR`, v1.1.0) | monthly blog digest email (module §19.18): `packages/aicompany/scripts/blog-digest.ts`. Fires daily; the SCRIPT is the gate — `reports.monthlyDigest` month guard (day ≥ dayOfMonth ∧ lastSentMonth < currentMonth) makes it monthly and `Persistent=true` boot catch-up correct; stamps `data/blog-digest-last` on every exit path (watchdog checks >35 d, §9.6); logs `/var/log/aiwebsite-blog-digest.log`. Gated on `BLOG_ENABLED=1` |
| `aiwebsite-backup` | daily 07:15 | `backup-db.sh`: `pg_dump aiwebsite \| gzip` → `$BACKUP_BUCKET` (+ `latest.sql.gz`), refuses <500 MB free disk, rejects dumps <100 KB, 30-day bucket retention, stamps the heartbeat the watchdog checks. **BACKUP_BUCKET is currently EMPTY** — no bucket exists for aiwebsite yet, so every run fails loudly (`[aiwebsite] CRITICAL Database backup FAILED` nightly) until one is provisioned (go-live TODO in site-deploy.env; Azure Blob `azblob://…` is the natural fit — the VM is Azure) |
| `aiwebsite-restore-drill` | quarterly (Jan/Apr/Jul/Oct 5th, 06:30) | restores `latest.sql.gz` into a scratch DB, sanity-checks row counts, drops it, emails pass/fail either way — a backup that cannot be restored is not a backup |
| `aiwebsite-retention-sweeper` | weekly Sun 05:30 | deletes `page_visits` >730 d, `auth_logs` >365 d, `ip_orgs` >730 d, `admin_emails` >730 d — **must match `privacy.retentionDays`** in site.config.ts (sms_consent_logs exempt by design). Since v1.1.0 also probes `blog_cta_events` via `to_regclass` (>400 d, `RETAIN_BLOG_CTA_EVENTS_DAYS`) — the table is absent here (cta.funnelEvents not adopted), so the sweep self-skips |
| `aiwebsite-disk-check` | daily 06:45 | alert at >80 % disk on `/` |
| `aiwebsite-governance` | daily 04:30 (+ ≤300 s jitter) | governance daily duties (§5.12/§8.1): guarded 30-day retention sweep, stale-research reaper, queued-project kicks, usage prune, standards watch + self-gated quarterly deep research + seed upserts. **Installed by `deploy/post-install.sh` (host-owned, NOT template-rendered, no stamp)**; `OnFailure=aiwebsite-governance-alert.service` (CRITICAL email); `NODE_OPTIONS=--max-old-space-size=256`; exits quietly while the deploy marker is fresh; logs `/var/log/aiwebsite-governance.log` (research jobs: `-research.log`). Uninstall: the hook's manifest loop, or `systemctl disable --now aiwebsite-governance.timer` + rm the three units |

---

## 10. Environment variables (single shared `.env`, site + brain + deploy)

Generate secrets with `openssl rand -hex 32`. `.env.example` is the authoritative template —
every variable below appears there with a comment. Config↔env cross-checks (e.g.
`NEXT_PUBLIC_BASE_URL === site.baseUrl`, `TWILIO_PHONE_NUMBER === channels.sms.phoneNumber`,
`BRAIN_PUBLIC_URL === baseUrl + "/brain"`) run at process start (`instrumentation.ts`) and
via `npm run config:check` in deploy (module architecture.md §4.3/§10).

| Group | Var | Value / purpose |
|---|---|---|
| DB | `DATABASE_URL` | `postgresql://aiwebsite:aiwebsite@localhost:5432/aiwebsite` (site; throws if unset) |
| Brain | `BRAIN_BASE_URL` | `http://127.0.0.1:3211` |
| | `BRAIN_STUB` | **dev only**: `=1` serves canned NDJSON streams from @aicompany/core — no brain process/OpenAI key needed; config:check fails the boot if set in production |
| | `BRAIN_API_KEYS` | comma list; **set in prod** (brain fail-closed since v1.92); site uses first key as Bearer |
| | `BRAIN_PUBLIC_URL` | **exactly** `https://ai.xl.net/brain` (Twilio signature base) |
| | `BRAIN_DB_BACKEND` / `BRAIN_POSTGRES_URL` / `BRAIN_DB_TABLE_PREFIX` | `postgres` / same DB as site / `brain_` |
| | `BRAIN_AUDIO_MODE` | `xai_realtime` |
| | `BRAIN_ROUTER` | router v2 staged-rollout flag (brain v1.97, Issue #695): `legacy` (default, behavior-identical) / `shadow` (log v2 selections, act on legacy) / `v2`; unset everywhere until the rollout begins |
| LLMs | `OPENAI_API_KEY`, `OPENAI_MODEL` (gpt-5-mini), `BRAIN_FIRST_PASS_MODEL` (gpt-5.4-mini), `OPENAI_TTS_MODEL` (tts-1), `OPENAI_STT_MODEL` (whisper-1) | brain chat/voice |
| | `XAI_API_KEY` | realtime voice (calls drop without it) |
| | `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `AA_API_KEY` | optional brain providers |
| | `TAVILY_API_KEY` | brain web_search backend AND **required for the blog** (§5.11): the news prefetch + `blog.dataSource` search it; unset ⇒ the nightly blog run WARN-skips |
| Blog | `BLOG_ENABLED` (0/1), `BLOG_ONCALENDAR` (systemd timer, default `*-*-* 09:30:00 UTC`) | in `deploy/site-deploy.env`; the rendered setup-vm.sh installs the timer only when 1 (§5.11/§9.7) |
| | `INDEXNOW_KEY` | optional; when set, blog publishes ping IndexNow and `/indexnow-key.txt` serves the key (not adopted yet) |
| | `GOOGLE_GEMINI_API_KEY` | Google AI Studio key (set 2026-07-10) — enables the brain's Gemini planner (`gemini-3.1-pro-preview`) + google models in the router; if it ever fails, the planner falls back to OpenAI (brain Issue #684). NOTE: the brain reads exactly this name, not `GEMINI_API_KEY` |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_PHONE_NUMBER` | number +1 872 350 4325, SID `PN9435882fd720d7ec79108d195f4c9e39`; same number sends the /texting verification codes (§5.7) |
| | `INBOUND_PHONE_PERSONA_NAME` / `INBOUND_PHONE_SITE` / `INBOUND_PHONE_GREETING` | voice persona (Tron Netter / ai.xl.net) |
| Email | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (svix inbound), `MAIL_FROM` (`Tron Netter <Tron.Netter@ai.xl.net>`), `CONTACT_NOTIFY_EMAIL`, `OUTBOUND_BCC_EMAIL` (default adam@xl.net — mandatory oversight BCC) | ai.xl.net domain verified in Resend |
| Auth | `SESSION_COOKIE_SECRET` (≥32 chars), `ADMIN_EMAIL` (comma list — gates `/admin` + `/api/admin/*`, currently adam@xl.net) | |
| Admin | `INTERNAL_TRACK_SECRET` | auth for middleware→`/api/internal/track` beacons; unset = visit tracking off (SEO/Companies pages stay empty) |
| | `MAXMIND_DB_PATH` | optional; default `<cwd>/data/GeoLite2-ASN.mmdb` (IP→org for /admin/companies) |
| | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | `https://ai.xl.net/auth/google/callback` (GCP project `xl-website-1682362315172`, client "ai.xl.net") |
| | `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_REDIRECT_URI` / `MICROSOFT_TENANT_ID` (default `common`) | Entra app `e66a2e8f-c1c1-4b63-9ffe-245db7d5363c` |
| Stripe | `STRIPE_SECRET_KEY` | secret API key for `/api/checkout` (§5.10); unset ⇒ the route returns 503 and the /builders buy buttons show a friendly error |
| | `STRIPE_PRICE_COHORT` | optional dashboard-managed Price ID override; unset ⇒ inline `price_data` ($495/mo recurring) |
| Ticket Tailor | `TICKETTAILOR_API_KEY` | **not read by site code** — ops-only key in the dev box `.env` for managing workshop events via `api.tickettailor.com/v1` (§5.10); the site only links to the public event page |
| Governance | `GOVERNANCE_ENABLED` | kill switch (§5.12): `0` = mutations 503, reads/downloads stay up, the timer keeps sweeping. Unset = enabled |
| | `GOVERNANCE_TAVILY_DAILY_CAP` (default 300) / `GOVERNANCE_BRAIN_DAILY_CAP` (default 1500) | global daily budgets in the `governance_usage` ledger (~7 Tavily calls per fresh domain incl. standard probes; brain ~$0.10/turn so 1500 ≈ $150/day worst case); runtime-overridable via the Troy approval loop, clamped to BUDGET_CEILINGS (§5.12) |
| | `GOVERNANCE_TAVILY_MONTHLY_WARN` (default 6000) | MTD Tavily WARN threshold in the governance timer's report |
| Site | `NEXT_PUBLIC_BASE_URL` (`https://ai.xl.net`), `NEXT_PUBLIC_SITE_NAME` (`XL.net AI`) | |
| | `TRON_KNOWLEDGE_FILE` | **legacy, no longer read** — the knowledge path is `persona.knowledgeFile` in site.config.ts |
| Crawl | `KNOWLEDGE_NOTIFY_EMAIL` / `ADMIN_EMAIL` | report recipient fallbacks |
| Misc | `AUTOMATION_SECRET` (skills-host), `DEFAULT_BRAIN_NAME`, `DEFAULT_PURPOSE` | brain persona defaults |
| Build | `SKIP_ENV_VALIDATION` | set by `next build` only — skips the module's runtime env validation |
| Deploy | `AIWEBSITE_SSH_IP` (52.237.160.75), `AIWEBSITE_USER` (xladmin), `AIWEBSITE_SSH_KEY` (optional key path; default `SSH_KEY_PATH=~/.ssh/id_ed25519` — ssh-key transport, current since 2026-07-12), `AIWEBSITE_PW` (legacy sshpass transport, break-glass only; deploy.sh requires `--allow-sshpass`) | consumed only by deploy.sh on the dev box, read literally |

---

## 11. External accounts required for a rebuild

| Service | What must exist |
|---|---|
| **Cloudflare** (xl.net zone) | Tunnel `aiwebsite` + credentials JSON; CNAME `ai` → `<tunnel-id>.cfargotunnel.com`, Proxied. DNS edits are human-only |
| **Twilio** | Number +1 (872) 350-4325 ("Tron Netter - XL.net AI"); voice webhooks → `https://ai.xl.net/brain/twilio/voice/{inbound,fallback,status}`; SMS webhook → `https://ai.xl.net/api/tron-netter/sms`; account SID/token + API key pair |
| **Resend** | Domain `ai.xl.net` verified (send); inbound routing for `Tron.Netter@ai.xl.net` → webhook `https://ai.xl.net/api/webhooks/resend` (svix secret). Account is shared with itsupportchicago.net — hence the domain filter in §5.3 |
| **Google Cloud** | OAuth consent screen "XL.net AI" (External, published) + web client "ai.xl.net", redirects `https://ai.xl.net/auth/google/callback` and `http://localhost:3000/auth/google/callback`. Manual console work — see `deploy/GOOGLE-OAUTH-SETUP.md` |
| **Microsoft Entra** | App `e66a2e8f-c1c1-4b63-9ffe-245db7d5363c` (creatable via `az ad app create`), redirect `https://ai.xl.net/auth/microsoft/callback` |
| **Stripe** | Account with a secret API key (`STRIPE_SECRET_KEY`); no dashboard product setup required (inline `price_data`), but receipt emails should be enabled in dashboard settings. Purchases/subscriptions are managed in the dashboard (no local orders table) |
| **OpenAI / xAI / Anthropic / Deepgram / Tavily** | API keys per §10 |
| **Azure VM** | Ubuntu-family box, ssh password auth for deploy.sh (hardening note in GO-LIVE.md: switch to keys) |

---

## 12. Cleanroom rebuild order

1. **Repo + submodules**: scaffold per §3; `git submodule add
   https://github.com/adampr/xldev.git packages/brain` and `git submodule add
   https://github.com/adampr/aicompany.git packages/aicompany`; `"@aicompany/core":
   "file:packages/aicompany"` + `transpilePackages` (module architecture.md §12 is the
   full host-integration contract).
2. **Config**: `site.config.ts` with the §4/§5 values (persona identity, copy, consent
   text — this doc's quotes are the canonical values) + `instrumentation.ts`.
3. **DB layer**: compose the module schema factories + `contact_submissions` (§6) →
   `db:generate` → commit migrations.
4. **Site**: layout/design system + `--site-*` tokens (§4) → pages → mount the wrapper
   routes (§5 table). Test chat against a locally-booted brain (`BRAIN_STUB=1` first, then
   `npm run bootstrap` inside the brain; SQLite backend is fine for dev).
5. **Persona knowledge**: hand-written starter `data/tron-netter-knowledge.md`
   (>1000 chars) until the crawler runs.
6. **Crawler** (§8): run the module crawler manually with `--no-email`, verify the three sinks.
7. **Deploy layer** (§9): fill `deploy/site-deploy.env` → `node
   packages/aicompany/deploy/render.mjs` → commit rendered scripts. Provision external
   accounts (§11), assemble `.env` (§10).
8. **Go live**: deploy, seed memories, DNS CNAME (human), point Twilio + Resend webhooks at
   the public URLs, verify all four channels: page render, chat stream, SMS round-trip,
   email round-trip, voice call.

## 13. Verification checklist (post-deploy)

```
curl -s https://ai.xl.net/api/health            # {"status":"ok"}
curl -s http://127.0.0.1:3211/health            # {"ok":true,"service":"brain-api",...}   (on VM)
curl -s http://127.0.0.1:3213/health            # skills-host ok                          (on VM)
pm2 ls                                          # aiwebsite / brain-api / skills-host online
journalctl -u cloudflared -n 20                 # tunnel connected
systemctl list-timers 'aiwebsite-*'             # all 8 timers present (§9.7; blog + blog-digest gated on BLOG_ENABLED)
psql -c "select count(*) from brain_memories where scope='public'"   # ≥7 seed rows
ls -la /var/lib/aiwebsite/last-backup-ok        # after the first backup window (needs BACKUP_BUCKET)

# Governance (§5.12/§8.1) — or run everything below via deploy/verify-governance.sh:
systemctl cat aiwebsite-governance.service | grep -E 'ExecStart|OnFailure|max-old-space'
psql -tAc "select to_regclass('public.governance_projects') is not null"   # t
curl -s https://ai.xl.net/governance | grep -qi "sign in" && echo gated-ok
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ai.xl.net/api/governance/projects  # 401/403 (mounted, session+CSRF gated)
# Bootstrap (first deploy only; runs 3 standards of deep research, ~10-20 min):
sudo systemctl start --no-block aiwebsite-governance.service && tail -f /var/log/aiwebsite-governance.log
# THEN (post-bootstrap): 3 non-empty .md + digest + state.json, and 4 seed rows
ls -la /var/www/aiwebsite/data/governance-standards/
psql -tAc "select count(*) from brain_memories where source_type='seed' and id like 'seed-gov-%'"   # 4
```
Then: chat widget streams tokens; text the Twilio number and get a reply <1200 chars; email
Tron.Netter@ai.xl.net and get a reply (BCC lands at adam@xl.net); call the number. Sign in
as adam@xl.net → the user menu shows "Admin"; `/admin/conversations` lists the test
exchanges above and `/admin/seo` starts counting visits (needs `INTERNAL_TRACK_SECRET`).
Sign in and register a number at `/texting`: the 6-digit code arrives by SMS, verifying it
sets `users.phone` + adds an `sms_consent_logs` row, and a confirmation text follows;
`/account` then shows the linked number and "Remove my number" unlinks it (appending the
opt-out consent row).

Common failures (from GO-LIVE.md): Twilio 403 → `BRAIN_PUBLIC_URL` not exactly
`https://ai.xl.net/brain`; calls drop → `XAI_API_KEY`; brain 503 → `OPENAI_API_KEY`;
tunnel up but 502 → nginx or PM2 down.

---

## 14. Module dependency & design review personas

**This site consumes @aicompany/core v1.15.2 (submodule `packages/aicompany`,
tag `v1.15.2`, master lineage — v1.14.0 adds the stored-verdict mode to the
headless publish CLI (`--stored-verdict`, module §19.10): a fresh (<60 min),
material-hash-bound, fully-clean authoring verdict publishes with nightly
trust, closing the review-refetch nondeterminism loop that refused two
ladder-clean drafts on 2026-07-22; v1.13.0 replaces the in-live-tree deploy
build with the staged zero-downtime cutover pipeline (`deploy/stage-build.sh`,
§9.1/§9.2 here; module §9.2/§9.5 + MIGRATIONS v1.13.0 contracts: hook cwd =
stage, hook-mutated trees must be in the flip set, env edits by absolute live
path — this host's governance post-install hook is compliant as-is);
v1.12.0 adds the headless draft-publish CLI
(`scripts/blog-publish.ts`, module §19.10): after a targeted
`--regenerate=<slug>` lands a fresh-gated draft, the CLI publishes it with the
exact admin semantics and REFUSES (exit 2) when the fresh verdict would land
noindexed; this host's packaged runbook `deploy/regen-noindexed.sh <slugs…>`
chains regenerate→publish per slug over the ssh-key transport, prints
before/after ground-truth enumeration, and never passes `--allow-noindex`
(human-only flag); `deploy/regen-noindexed-async.sh` is the detached variant
(nohup on the VM writing `/tmp/regen-noindexed-<ts>.log` + a `.done` marker
— panel-forced writer calls make one slug take many minutes, so an
interactive ssh would die mid-write), polled by the read-only
`deploy/read-prod-blog-status.sh` (non-clean rows + newest log tail); the 1fb62f1 branch pin returned to master when
v1.9.0 merged `fix/chat-widget-css-scope`; v1.10.0 adds the blog escalation
ladder this host opts into with `quality.maxRegenerates: 1`; v1.11.0 adds
page-aware webchat + hover gestures + conversational issue reporting, both
default-ON — the module privacy page renders the new Chat Page Context /
Issue Reports disclosure sections automatically, `[aiwebsite] ISSUE` emails
arrive at oversight.alertEmail, and this host is the §13 canary for the
module MIGRATIONS v1.11.0 soak checklist: `issue_report … marker unparseable`
rates + §18.8 page-title-derived memory grep).** The v1.0.1 every-host deltas are live: refreshed `DEFAULT_AI_BOTS`
robots.txt group, Organization JSON-LD `"@id": "<baseUrl>/#org"`, `TrafficSource "ai"`
(/admin/seo source trends have a discontinuity at 2026-07-11); v1.0.2 adds the
sibling-recipient log-only skip (inbound mail addressed to a `siblingSites` persona no
longer WARN-alerts); v1.0.3 fixes the blog engine's brain calls (`response_format` field,
`goals` array — it never worked on a real run before, §5.11) and is the version that
adopts the blog; v1.0.4 exempts clearly-attributed persona opinion from the fact-check
gate (an opinion sentence is flagged only when it embeds a specific unsupported
verifiable assertion — first-person editorial styleGuides no longer auto-fail gate 2);
v1.1.0 adds the blog measurement/distribution loop (this host adopts none of its optional
features — §5.11; mandatory pieces: `blog_posts` prune columns in migration `0007`, the
digest timer, and the re-rendered deploy scripts); v1.1.1 hardens Gate 1 (leak/artifact
scrubs); v1.2.0 is the SMS onboarding/continuity release this host fully adopts
(`sms_notices` table, `optInKeywords` consent recording — `start`/`unstop` left
`silentKeywords`, §5.2 — registration invite, footer-reserve truncation, GSM-7 default-copy
fixes [host overrides unaffected], `<AccountSettings/>` on `/account` + the two
`/api/texting/{settings,remove}` wrappers, §5.7); v1.2.1 makes blog auto-links reach the
reader and scopes the dead-internal-link gate (§5.11).
`deploy/site-deploy.env` carries `BLOG_ENABLED` / `BLOG_ONCALENDAR` and, since v1.1.0, the
**required** `BLOG_DIGEST_ONCALENDAR` (render.mjs fails without it) + optional
`RETAIN_BLOG_CTA_EVENTS_DAYS` (see §5.11/§9.7). The v1.3.0 bump (template update) added
the two **required** resource-cap keys: `BRAIN_API_MAX_MEMORY=2600M` (blog-sized brain
turns hold ~2.4GB RSS; pm2 restart threshold) and `BUILD_HEAP_MB=1024` (heap cap for the
on-VM `next build`).
Hosts pin the submodule by SHA against a tag and apply `packages/aicompany/MIGRATIONS.md`
entries in sequence on every bump (`npm run upgrade:check --dry-run` lists pending steps);
aiwebsite is the module's **canary host** — releases soak here 3 days before other hosts bump.

Substantial changes to this system (new pages/flows, channel behavior, admin
surfaces, deploy/ops changes) and to this document are reviewed against a standing
persona panel — the same review-board pattern as itsupportchicago.net's
ARCHITECTURE.md §21 ("Architecture Review Angles"), generalized in the shared
module repo (`adampr/aicompany`, `PERSONAS.md`):

| # | Persona | Reviews for |
|---|---|---|
| 1 | **UX/UI Designer (world-class)** | visitor + admin flows, chat streaming UX, theme parity (dark/light, pre-paint), reduced motion, designed failure states |
| 2 | **Software Architect (world-class)** | contracts and boundaries, cleanroom-rebuild completeness of this doc, failure modes, migration paths |
| 3 | **Marketing/SEO Strategist (world-class)** | SSR/metadata/JSON-LD, conversion paths across all four channels, first-party analytics quality, brand differentiation |
| 4 | **Design Critic** | undesigned states (empty/error/slow/disconnect), WCAG 2.1 AA, clone-look risk across sites |
| 5 | **Architecture/Security Critic** | webhook signature verification, SSRF/open-redirect/session hygiene, fail-closed endpoints, upgrade hazards |
| 6 | **Marketing Critic (trust & privacy)** | cross-brand leakage on shared Twilio/Resend accounts, tracking disclosure and retention, skeptical-visitor trust |
| 7 | **Solo Operator Critic** | watchdog coverage, backups/restore drills, log rotation, memory budget, crons, alert throttling |

Protocol: personas review in parallel; findings are classified blocking /
should-fix / note; blocking and should-fix are applied or explicitly waived with
rationale. When a claim is aspirational, mark it "planned / not yet implemented" —
never describe unbuilt behavior as existing.
