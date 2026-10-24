# aiwebsite upgrade ledger: @aicompany/core v1.142.2 (4a6b821, release/1.142.x) -> v1.171.0 (af7ef97)

Final target v1.171.0 (rows for v1.170.0/v1.171.0 and the build-placement change are in "Round 2" below);
the first pass of this ledger stopped at v1.169.0 (8852ad7).

Built 2026-10-23 (CDT). Every MIGRATIONS.md entry v1.143.0..v1.169.0 read end to end
(roleplay checkout's copy); v1.170.0 and v1.171.0 were read from the aiwebsite submodule at v1.171.0 in round 2.
aiwebsite facts used below (read from the tree): site.config blog = single type `news`
(wordRange [600,1700]), cadence 7/week, maxNewPerDay 1, refreshPerWeek 0, topics.dynamic
true, calendar + seedHints, posture `publish_indexed`, panel `on`, maxRegenerates 1,
mechanics unset, measure+gsc on, metaRewrite OFF; audio `enabled: true`, Gemini primary
voice Charon with NO `model` and NO `style`, OpenAI fallback ballad; heroImage Gemini wired;
texting + memory ON, SMS channel without hostTurn/hostForget; site.timezone America/Chicago;
own magic-link request/verify wrappers; own /methodology page; site.config imports
`@/lib/db` (registerTables) as a side effect; no root playwright-core; build placement `local-artifact` since round 2
(dev-box `next build`, artifact shipped; it was `remote`, VM `npm ci --include=dev` + `next build`, at the start of this climb); no .env.local on the dev box.

(Command logs referenced below were kept in the build session's scratchpad, not in this repo.)

New host test: `scripts/aicompany-upgrade-contract-tests.ts` (`npm run test:aicompany`),
14 cases, cited below as T:<case>.

| ver | template? | schema/env/config step | behaviour that touches aiwebsite (grep result) | pinned by | host step |
|---|---|---|---|---|---|
| 1.143.0 | YES: setup-vm (blog TimeoutStartSec=7200, backup 3600), backup-db prose | none | aiwebsite's blog + backup units get a REAL run deadline for the first time (RuntimeMaxSec was inert). A blog run >2 h is now killed (Result=timeout). aiwebsite's run durations not measured from here | T:v1.143.0 (rendered units), render --check | re-rendered (done); after deploy: `systemctl show aiwebsite-blog.service -p TimeoutStartUSec` = 2h, backup = 1h, `cmp deploy/backup-db.sh /usr/local/bin/aiwebsite-backup-db.sh` |
| 1.144.0 | no | optional `redirect` body field | host request wrapper forwards `{ email }` only (route.ts:63-70), so no redirect rides; verify wrapper's `/` success test stays true. Two host comments were stale ("no redirect parameter exists") — corrected, comment-only | T:v1.144.0 (source pin) | none |
| 1.145.0 | no | optional `blog.audio.catchUp.enabled` | derived month cap = 400,000 floor (31 x 11,050 = 342,550); nightly audio catch-up turns ON (<=1 render/day, published <=35 d, silent rows only, never mails); Phase A narrates published rows only; publishRow withdraws a pre-publish narration | T:v1.145.0/v1.155.0 | none (no `maxCharsPerMonth` key — do not add one) |
| 1.146.0 | no | none | `[blog-ladder]` first-draft journal line; gate prompt-cache declarations (inert unless the judge is a verified gpt-5.6 id) | module suite | none |
| 1.147.0 | no | 3 optional SMS keys | no hostTurn/hostForget here -> byte-identical; resolved config gains `hostTurnTimeoutMs: 15000` | T:v1.147.0/v1.151.0 | none |
| 1.148.0 | no | optional `blog.topics.benchEvidence` | single-type rotation `news`: a decline benches it, then it is asked anyway (inert) | T:v1.148.0/v1.157.0 | none |
| 1.149.0 | no | none | GSC key parse classifier + `blog-gsc-pull` ledger row (aiwebsite GSC ok: row never opens); admin UNPUBLISH now deletes the article's `blog_audio` row (.mp3 404s) | module suite | none |
| 1.150.0 | no | none | scorecard inspect links (dev-box cron clone, not this repo) | n/a | none here (cron clone is a module/dev-box action) |
| 1.151.0 | no | 2 optional copy keys (defaults) | aiwebsite HAS texting + memory: Remove / change-number now DETACHES the number (brain rows move to the account, sms-<n> session retired, notices re-armed); FORGET no longer reaches another requester's rows and erases every session-keyed table (thinking_passes too); hand-back re-keys every requester-keyed table. Numbers removed BEFORE this release are not backfilled (owner review, below) | module suite (brain-number-detach.pg etc.) | none required; DECISION D4 |
| 1.152.0 | no | none | not-due night rule; aiwebsite publishes every run -> 0 | module suite | none |
| 1.153.0 | no | none | scorecard split-key (dev-box cron) | n/a | none |
| 1.154.0 | no | `enabled` now opt-out | aiwebsite writes `enabled: true` -> resolves `enabledBy: "explicit"`; nothing changes | T:v1.154.0 | none |
| 1.155.0 | no | 2 optional audio keys (defaults 25/40) | speaking-rate guard live on Charon; cold open becomes "From X.L. dot net A.I. <disclosure> <title>."; outro speaks "ai dot X.L. dot net"; ISO dates in words; "In short." label; every row's render hash moves, NOTHING re-renders by itself. Module methodology-page change is inert (host renders its OWN /methodology). Refresh-off yield ring: empty here | T:v1.145.0/v1.155.0, T:refresh-off | none; listen to the first new narration (DECISION D2) |
| 1.156.0 | no | none | refresh non-regression: refresh 0 -> inert | T:refresh-off | none |
| 1.157.0 | no | none | saturation steady state: single type, not saturated -> inert | T:v1.148.0/v1.157.0 | none |
| 1.158.0 | no | none | derived ceiling = 12 (1+5+3+3), unchanged; WRITER_UNSUPPORTED_CLAIM_RULE reaches every aiwebsite article (stricter than the checker; effect on voiceAdherence UNDETERMINED); negative-coverage anchor skip (no such heading on this sheet) | T:ceiling | none; 14-night watch of `voiceAdherence` + first-draft fact-check lines owed post-deploy |
| 1.158.1 | no | none | module `next` devDep `^16.3.8`; host locks next 16.4.2 -> dedupes | T:no-nested | lock link entry updated (done) |
| 1.158.2 | no | none | db registry + pools process-global. aiwebsite was measured clean on 16.3.8 (2026-10-12) because site.config imports `@/lib/db` into every route graph; the module asks "take >= v1.159.0 before/with next 16.4": the host lock ALREADY says next 16.4.2 (ad9aee3e) and prod ran it with v1.142.2 | T:v1.158.2 (registry via the real site.config); local `next build` | post-deploy verify: /rss.xml 200, cache-busted hero 200, page_visits growing, `grep -c "is not registered"` pm2 out log = 0 |
| 1.159.0 | no | none | `[blog-run]` journal line; preflight CLI (not used here); doctor SMS check reads the Messaging Service URL | module suite | none |
| 1.160.0 | no | none | refresh withhold: refresh 0 AND posture publish_indexed -> inert | T:refresh-off | none |
| 1.161.0 | YES: setup-vm, stage-build (`browser` step), watchdog (browser-only kill = WARN) | none | no root playwright-core -> `>>> browser: no playwright-core in the staged app — nothing to provision`; earlyoom `--prefer` gains chrome/chromium/headless_shell (no browser here, so no effect); a sentinel kill during the step aborts before cutover | T:v1.161.0 | re-rendered (done); read the `>>> browser:` line in the deploy log |
| 1.162.0 | no | none | repair non-regression on the GENERATION path (a loosening of Phase A's min-score clause, booked); keep-links rule in the repair prompt; `[blog-repair]`/`[blog-ladder] step=` lines. Applies here (posture publish_indexed: an adoption publishes indexed OK instead of indexed WARN) | module suite | none; DECISION D3 (owner awareness of the loosening) |
| 1.163.0 | no | none | `blog-publish.ts --stored-llm-verdict/--published-at` (operator CLI); admin edit_meta stamps `editedAfterGatingAt` | module suite | none |
| 1.164.0 | no | optional `blog.quality.mechanics` (off) | off -> byte-identical | T:ceiling (mechanics 0) | none |
| 1.165.0 | no | none (exported-API arity change) | lane D: article budget counts the CHICAGO day/ISO week (no host caller of isArticleDue/effectiveWeeklyCap/expectedMaxAgeDays/evaluateLiveness — grepped); lane M: solo-arm throughput (aiwebsite is a panel host: convened nights unchanged) | T:v1.165.0 (real isArticleDue with the host zone) | none |
| 1.165.1 | no | none | module lockfile only | T:no-nested | none |
| 1.166.0 | no | none | maxRegenerates 1 -> byte-identical prompts; journal lines gain `notes=` (no host wrapper lifts stdout here) | T:ceiling (maxRegenerates 1) | none |
| 1.167.0 | no | none | upstream-outage retry (fresh promptId, 20 s/40 s, 120 s/run); hero waits 10 s/30 s, a 4xx stops after 1; HERO CATCH-UP: <=1 image-less published row (<=14 d) per run gets <=3 Gemini image calls | module suite | count image-less rows on prod first (read-only SQL in the entry) — owed, not measurable from the dev box |
| 1.168.0 | no | optional factory `style` | **the one with a date**: Charon moves gemini-2.5-flash-preview-tts -> gemini-3.8-flash-tts (no host model pin); structured body, l16 24 kHz asked; RIFF tolerated. Render hash of every Gemini row moves; nothing re-renders by itself; stored 2.5 MP3s keep serving after 11-17. Price $9/M audio out to 2026-12-31 then $18/M (~+80 % vs today). Without this bump, from 2026-11-17 every article publishes SILENT and `audio-warn:primary-down` mails nightly | T:v1.168.0 (real generator: modelId, voice, body, distinct fallback); live probe of Charon on 3.8 (see gate log) | deploy BEFORE 2026-11-17; listen to the first file; DECISIONS D1/D2 |
| 1.169.0 | no | none | crawler retry/degraded gate (`deferred for retry` log wording replaces `retrying once`) | module suite | none (grep for the new wording) |

## DECISIONS (Adam's)

- D1. Gemini TTS `style` (v1.168.0, optional, module ships none): leave unset (the
  shipped/measured shape, what the test pins) or set a delivery line for Charon on 3.8
  (e.g. the fallback's "Read calmly, like a news narrator. Even pace, no theatrics.")?
  Recommendation: leave unset this round; any style is a separate measured change.
- D2. Back-catalog narration: after the bump new articles narrate on 3.8 (and the v1.155.0
  cold open); the existing ~library keeps its 2.5 files. Re-seat any rows
  (`cli/backfill-audio.ts --slug <s> --reseat`, counts against the 400,000 month cap)
  — e.g. fallback(ballad)-narrated rows — or leave them? Recommendation: leave; revisit
  after one listen.
- D3. v1.162.0 is a booked rubric LOOSENING on the generation-path repair (one dimension one
  step under the floor, average bar still met, adopts). On this publish_indexed host it
  changes a WARN-mailed indexed publish into a silent OK publish on such nights. Accept
  (default at bump) or not — there is no config switch; declining means not taking >= v1.162.0.
- D4. v1.151.0 numbers removed BEFORE this release were never detached (old owner's working
  state/event tape stays keyed to the number). Run the module's read-only finder on prod
  (`SELECT phone,user_id,created_at FROM sms_consent_logs WHERE consent_text IN (...)`) and
  review each by hand, or accept. No backfill script exists by design.
- D5. Canary: v1.168.0 / v1.169.0 record deviations because aiwebsite (the §13 canary) was 26
  releases behind. Deploying the full climb to aiwebsite now makes it the LAST host on these
  releases, not a canary — note it in the deploy record.

## Owed post-deploy checks (VM, read-only)
systemctl TimeoutStartUSec (2h/1h) + backup-script cmp; `>>> browser:` line; /rss.xml 200;
hero 200; page_visits growing; `is not registered` = 0; first nightly `[blog-audio]` line on
gemini-3.8-flash-tts with `guard=` 0 and the file listened to; the module-version stamp: the deploy stamps itself (deploy/setup-vm.sh:1502-1504); the check is the log line ">>> Stamping deployed module version" with no "WARNING: upgrade:check --stamp failed" after it
(prod stamp unknown from here; the dev DB is stamped 1.98.0, stale); the hero catch-up
count query; blog run durations vs the new 2 h bound.

## D0 — DEPLOY BLOCKER found by the gate (Adam's / parent's call; NOT changed here)
The VM build runs `NODE_OPTIONS=--max-old-space-size=${BUILD_HEAP_MB}` with
`BUILD_HEAP_MB=1024` (deploy/site-deploy.env:37). Local build at that cap:
- v1.169.0: `next build` OOMs in "Running TypeScript" (FATAL heap out of memory, "Failed to type check").
- v1.142.2 (same tree, new test file parked): passes, TypeScript 44 s, no banned warnings.
- Measured cause: standalone `tsc --noEmit` memory 1,149,524 K -> 1,322,352 K (+15 %), lines 277,180 -> 289,824 (the module's own source grew).
- v1.169.0 at heap 2048: build passes, TypeScript 38 s, no banned warnings, max RSS 4.26 GB (dev box, 7 workers) vs STAGE_MEM_MAX_MB=5120.
Options: raise BUILD_HEAP_MB (e.g. 2048; re-render; the whole step stays inside the 5120 MB cgroup cap, ~0.9 GB margin measured on the dev box), or switch to local-artifact builds. Without one, the deploy fails safely before cutover.

## Gate results (2026-10-23)
npm ci --include=dev OK (one next 16.4.2 / react 19.3.1 / resend 6.34.1, module deduped); tsc --noEmit 0;
lint 5 errors / 44 warnings = the 5 pre-existing react-hooks errors recorded in ad9aee3e (untouched files);
44 test:* scripts: 43 green, test:rfpoutline 2 failing, reproduced identically at v1.142.2 (host RFP pickedAt logic, unrelated);
test:aicompany 14/14; config:check FAILED on dev-DB schema drift only (host migrations 0062-0065 not applied to the local dev DB);
upgrade:check: dev DB stamped 1.98.0 (stale), lists 92 entries; prod stamp unknown from here;
build: see D0; live probe check-tts-voice Charon on gemini-3.8-flash-tts PASS band 77.0 % crest 16.4 dB 26.6 s for 482 chars (18.1 chars/s, under the 25 guard);
npm audit --omit=dev: 4 moderate (esbuild <=0.24.2 via drizzle-kit's @esbuild-kit), pre-existing, fix is a drizzle-kit downgrade.

## Round 2 (coordinator, 2026-10-23): target moved to v1.171.0 (af7ef97); build mode local-artifact

| ver | template? | schema/env/config step | behaviour that touches aiwebsite | pinned by | host step |
|---|---|---|---|---|---|
| 1.170.0 | no | none | dev-box synth sweep mails fleet Node runtime drift (cron clone, not this repo) | n/a | none |
| 1.171.0 | YES: setup-vm (knowledge/blog/blog-digest units get `Environment=PATH=<TOOLCHAIN_PATH_PREFIX>:…`) | none (derived key TOOLCHAIN_UNIT_ENV; render now validates TOOLCHAIN_PATH_PREFIX) | prefix is EMPTY here (`TOOLCHAIN_PATH_PREFIX=`) -> rendered setup-vm.sh differs from the v1.169.0 render by the stamp line ONLY (diffed) | render --check; T:pin (1.171.0) | re-rendered |

D0 RESOLVED (Adam): `DEPLOY_BUILD_MODE=local-artifact`, `LOCAL_BUILD_HEAP_MB=8192` (fleet value = module default;
the local build's heap comes from LOCAL_BUILD_HEAP_MB, rendered into deploy.sh). BUILD_HEAP_MB=1024 kept (required
key; inert: stage-build.sh build refuses in this mode). Consequence found and fixed: the local build reads the DEV
.env, so ISR routes that read the DB at build time baked dev data — measured: the artifact's /sitemap.xml had 12 locs
and ONE /blog/ article. src/app/sitemap.ts and src/app/work/page.tsx -> `force-dynamic` (roleplay c87a820 precedent).
NEXT_PUBLIC_BASE_URL in the dev .env is https://ai.xl.net (match-count check, value not printed); no NEXT_PUBLIC pin files.
D1 RESOLVED: TTS style unset. D2 RESOLVED: back catalog left as is. D3 ACCEPTED (named in the pin paragraph).
D5 RECORDED: aiwebsite (the §13 canary) adopts LAST; roleplay first on 2026-10-23.

## After deploy (read-only, prod) — exact commands
- D4 (module v1.151.0 "Numbers released BEFORE v1.151.0"), on the VM against the aiwebsite DB:
  `SELECT phone, user_id, created_at FROM sms_consent_logs WHERE consent_text IN ('account: number removed by account holder', 'account: number replaced by account holder');`
  (count for Adam: wrap as `SELECT count(*) FROM sms_consent_logs WHERE consent_text IN (…same two strings…);`). Review each row by hand; the module ships no backfill.
- v1.167.0 hero catch-up reach: `SELECT count(*) FROM blog_posts WHERE status = 'published' AND hero_image IS NULL AND published_at > now() - interval '14 days';`
- v1.143.0: `systemctl show aiwebsite-blog.service -p TimeoutStartUSec` (2h), `systemctl show aiwebsite-backup.service -p TimeoutStartUSec` (1h), `cmp /var/www/aiwebsite/deploy/backup-db.sh /usr/local/bin/aiwebsite-backup-db.sh`.
- local-artifact: deploy log shows `>>> Local artifact build`, `artifact staged: BUILD_ID …`, `>>> browser: no playwright-core …`; `curl -s https://ai.xl.net/sitemap.xml | grep -c '<loc>'` is the full article count (not 12); /work shows prod cards.
- v1.158.2: /rss.xml 200, a cache-busted hero image 200, page_visits growing, `grep -c "is not registered" ~/.pm2/logs/aiwebsite-out*.log` = 0.
- v1.168.0: first nightly `[blog-audio]` line names gemini-3.8-flash-tts with guard=0; listen to that file.
- Module-version stamp: the deploy stamps itself (deploy/setup-vm.sh:1502-1504); the check is the log line ">>> Stamping deployed module version" with no "WARNING: upgrade:check --stamp failed" after it.
- Before the deploy: `pm2 jlist | jq -r '.[].name'` on the VM — local-artifact setup-vm DELETES any pm2 app other than aiwebsite, brain-api, skills-host, pm2-logrotate.

## Round-2 gate (final tree, 2026-10-23 17:36-17:39 CDT)
render --check: all 16 match. npm ci --include=dev rc 0 (lockfile newer, as deploy.sh would). tsc 0.
44 test:* : 43 green incl. test:aicompany 14/14 and test:deploysafe; test:rfpoutline 2 failing (pre-existing, same at v1.142.2).
Local-artifact build, exactly deploy.sh's block (node 22, no .env*.local to shield, rm -rf .next,
NODE_OPTIONS=--max-old-space-size=8192 npm run build): rc 0, 87 s wall, max RSS 4,146,256 KB; check-build-warnings OK;
relocatability hits 0; /sitemap.xml and /work now ƒ (dynamic), no baked sitemap body; artifact tarball (minus .next/cache) 95 MB.

## Round 3 (refuter R6: SHIP WITH FIXES, nothing blocking)
R6 measured on the VM: pm2 apps = exactly setup-vm's keep list (aiwebsite, brain-api, skills-host, pm2-logrotate); 98 G free;
blog runs 7-21 min against the new 2 h TimeoutStartSec; the deploy marker is six commits behind, so deploy-safe.sh will need --ack.
Fixes applied: lockfile re-resolved so `npm ls --package-lock-only --all` shows only the two pre-existing @emnapi lines (the
module's nested typescript / @types/node entries now satisfy its ^6.0.3 / ^22.20.5 ranges); revalidateWorkPage() is
revalidatePath only (the loopback on-demand ISR GET is gone; /work is force-dynamic (2026-10-23): the next request reads the
database); a database blip on /work now renders the page without the team cards (page.tsx catch) where ISR served the last
cached copy, accepted.
Round-3 gate (2026-10-23 evening CDT): `npm ls --package-lock-only --all` shows only the two pre-existing @emnapi invalids
(the module's stale nested typescript 5.9.3 / @types/node 22.20.1 lock entries were dropped; both dedupe to the root's
6.0.3 / 22.20.5); `npm ci --include=dev` rc 0; `tsc --noEmit` 0; test:work, workupdate, worksubmit, workattribute,
workexhibit, workquality, placements, workcounts, correlate, roadmap, aicompany (14/14), deploysafe (183/0) all green;
check-roadmap-caching OK; `render.mjs --check` all 16 match.
