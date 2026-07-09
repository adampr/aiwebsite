# ARCHITECTURE — ai.xl.net (XL.net AI site + Tron Netter)

> **Purpose of this document:** a complete, self-contained specification of this system,
> detailed enough to rebuild it from a clean room without reading the existing code.
> When code and this document disagree, the code wins — then fix this document.
>
> The brain engine (`packages/brain`) is a separate reusable repo with its own canonical
> architecture doc (`packages/brain/docs/Software_Brain_Canonical_Technical_Architecture_Master_v17.md`).
> This document specifies the brain only as far as this site consumes it (§7); rebuild the
> brain itself from its own doc.

Last verified against code: 2026-07-09 (brain submodule v1.92, Next.js 16.2.9).

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
has optional Google/Microsoft OAuth sign-in (§5.4) — purely additive; no page requires login.
Signed-in users can additionally register a mobile number for SMS at `/texting` (§5.7):
consent checkbox + a texted 6-digit code that must be entered on the site before the number
is saved (TCPA-style verified opt-in; legal pages at `/privacy` and `/sms-terms`).

Everything runs on **one Azure VM** (`xladmin@52.237.160.75`, app dir `/var/www/aiwebsite`)
behind a **Cloudflare tunnel**. There is no load balancer, no container runtime, no cloud
managed DB — just PM2, nginx, Postgres, and cloudflared on a single box.

### Human-oversight invariants (do not remove when rebuilding)

- **Every outbound email is BCC'd to `adam@xl.net`** (`OUTBOUND_BCC_EMAIL`, `src/lib/email/send.ts`).
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
  Bearer key (first entry of `BRAIN_API_KEYS`). brain-api v1.92 is **fail-closed**: every
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
├── src/                        Next.js 16 App Router source (§5)
│   ├── app/                    pages + API route handlers
│   ├── components/             client components (chat widget, theme, user menu, fx)
│   ├── lib/                    brain client, auth, oauth, db, email, persona, rate-limit
│   └── types/                  custom-element JSX typings
├── packages/brain/             git submodule ← https://github.com/adampr/xldev.git (§7)
├── data/                       VM-GENERATED knowledge files — gitignored from deploy --delete,
│   │                           rewritten nightly by the crawl (§8); never hand-edit
│   ├── tron-netter-knowledge.md        (~175 KB budgeted prompt doc, read at request time)
│   ├── tron-netter-knowledge-full.md   (~2.5 MB full crawl, audit only)
│   └── GeoLite2-ASN.mmdb               MaxMind IP→ASN db (12 MB, gitignored; deploy.sh ships it
│                                        explicitly; shared copy with itsupportchicago) (§5.6)
├── scripts/refresh-tron-knowledge.mjs  nightly crawler (§8)
├── deploy/                     provisioning, PM2, nginx, cloudflared, watchdog, seeds, runbooks (§9)
├── drizzle/migrations/         SQL migrations for the site's 9 tables (§6)
├── drizzle.config.ts           schema ./src/lib/db/schema.ts → ./drizzle/migrations, dialect postgresql
├── public/                     favicons, brand assets, fx.js (<xl-dust> canvas particles)
├── next.config.ts              trailingSlash:false; experimental.inlineCss:true — nothing else
├── postcss.config.mjs          single plugin: @tailwindcss/postcss
└── tsconfig.json               strict, bundler resolution, alias @/* → ./src/*, excludes packages/brain
```

**Stack versions:** Node **22** (VM; brain requires ≥20) · Next.js **16.2.9** · React **19.2.4**
· TypeScript 5 · Tailwind **v4** · drizzle-orm 0.45 + `postgres` 3.4 driver · resend 6.17
· maxmind 5 + mmdb-lib (IP→org for /admin/companies).
`src/middleware.ts` does CSRF origin checks for `/api/admin/*` mutations and fire-and-forget
page-view tracking (§5.6). No test suite in the parent repo (the brain has its own QA/benchmarks).

---

## 4. Frontend

Six public pages, all served from the root layout (`src/app/layout.tsx`), plus the
admin console under `/admin/*` (§5.6):

| URL | Type | Content |
|---|---|---|
| `/` | static server component | Marketing home: hero with `<xl-dust>` particle canvas, theme-aware animated logo iframes (`/brand/xl-logo-animated-{dark,light}.html`), stat cards (79.8% issue reduction, 24/7, 99.3% CSAT), capability panels, CTA → `/contact` |
| `/contact` | static server component | Contact info only — **no form** (email `Tron.Netter@ai.xl.net`, phone/SMS (872) 350-4325, points users at the chat widget); links to `/texting` |
| `/login` | client component | Sign-in card in `<Suspense>`; reads `?redirect`, `?error`, `?message`; links to `/api/auth/{google,microsoft}/start`; maps error codes (`missing_params`, `invalid_state`, `token_exchange`, `userinfo`, `no_email`, `rejected`, `provider_unconfigured`) to friendly text. `login/layout.tsx` sets `robots: noindex` |
| `/texting` | client component | SMS opt-in wizard (§5.7): session check → phone + consent checkbox (`SMS_CONSENT_TEXT` from `lib/texting.ts` + links to the legal pages) → 6-digit code entry (resend / change-number) → "Verified" panel. Signed-out users get a Sign In link with `?redirect=/texting`; already-opted-in users land on the done state. `texting/layout.tsx` holds the metadata |
| `/privacy` | static server component | Privacy policy: first-party-only tracking disclosure (page tracking, MaxMind company lookup, session hash), Tron Netter AI processing + human email oversight, account/SMS data, essential-cookies-only, third parties (OAuth, Resend, Twilio, Cloudflare, model providers), retention windows, contact Tron.Netter@ai.xl.net / (872) 350-4325 |
| `/sms-terms` | static server component | SMS program terms: program description (conversational replies + verification codes, no marketing), opt-in methods, verification-code mechanics, frequency/rates, STOP/HELP, carriers, privacy cross-link, contact |

The footer links Home, Contact, Text with Tron Netter (`/texting`), Privacy Policy, SMS
Terms, and the main xl.net site.

**Root layout** provides: metadata (title template `%s | XL.net AI`, `metadataBase` from
`NEXT_PUBLIC_BASE_URL`, OG/Twitter, JSON-LD `Organization` with SOC 2 Type II + ISO 27001:2022),
an inline **pre-paint theme script** (reads `localStorage.theme` / `prefers-color-scheme`, sets
`.dark` or `data-theme="light"` on `<html>` before first paint), sticky header (logo, nav,
`<ThemeToggle>`, `<UserMenu>`), footer, and — on every page — `<TronNetterChat>`, `<FuturismFx>`,
and `<Script src="/fx.js" strategy="afterInteractive">`.

**Styling:** Tailwind v4 + a custom "Elegant Futurism" design system (`src/app/futurism.css`,
~760 lines). Dark-first; light mode = `data-theme="light"` on `<html>`. Tokens are `oklch()` CSS
custom props (`--xl-bg-*`, `--xl-light*` cyan, `--xl-sand*` warm, `--xl-text*`, `--xl-line*`).
Fonts from Google Fonts: Julius Sans One (display), Manrope (UI), JetBrains Mono (data).
Dark variant: `@custom-variant dark (&:where(.dark, .dark *))`.

**Client components** (`src/components/`):

- `tron-netter-chat.tsx` — the floating chat widget. State (`{isOpen, messages, sessionId, hasUnread}`)
  persists in `sessionStorage["tron-netter-chat-state"]` (hydration-guarded). `sessionId` is
  client-generated: `tron_<base36 ts>_<rand>`. Sends `POST /api/tron-netter/chat` with header
  `Accept: application/x-ndjson` and body `{messages, sessionId}`, then reads the NDJSON stream
  via `res.body.getReader()`: `{type:"token",text}` append · `{type:"answer",text}` replace ·
  `{type:"done",answer?}` finalize · `{type:"error"}` error bubble. Falls back to buffered JSON
  `{answer}` if the response isn't NDJSON. Enter sends, Shift+Enter newline, unread dot when closed.
- `theme-toggle.tsx` — three-way `system → light → dark` cycle, `useSyncExternalStore`,
  persists `localStorage["theme"]`.
- `user-menu.tsx` — session via `useSession()`; "Sign In" link or avatar dropdown
  with Sign Out (`POST /api/auth/logout` → redirect `/`) and, when `isAdmin`, an "Admin" link
  to `/admin/analytics`.
- `sms-prompt-card.tsx` — post-sign-in SMS opt-in prompt (§5.8): dismissible bottom-left card
  (deliberately NOT a modal — TCPA opt-in must never gate or steal focus), shown iff the session
  says `smsPromptEligible` && not shown this browser session (`sessionStorage aix_sms_prompt_shown`)
  && not snoozed (`localStorage aix_sms_prompt_snooze_until`, 14 days) && pathname ∉
  {`/texting`, `/login`, `/admin*`} (reactive; landing on `/texting` counts as fulfilled).
  Actions: "Add my number" → `/texting?utm_source=sms_prompt`; "Not now" → snooze (3rd snooze
  silently becomes permanent); "Don't ask again" → permanent server-side dismissal. All actions
  emit funnel events to `POST /api/auth/sms-prompt`. Esc (focus inside) = Not now; plain
  `<section aria-labelledby>`, no live region, no focus steal; mobile leaves the chat FAB
  clear (`right-24` inset).
- `src/lib/use-session.ts` — shared client session state: `useSession()` hook + module-level
  promise so UserMenu, the SMS prompt card, and `/texting` dedupe to ONE
  `GET /api/auth/session` fetch per hard navigation; fetch failure resolves to signed-out;
  `invalidateSession()` clears the cache after mutations (e.g. phone verification).
- `email-link.tsx` — `<EmailLink email label? className?>`: mailto link wrapped in Cloudflare
  `<!--email_off-->` comments (via `dangerouslySetInnerHTML` — React can't emit HTML comments)
  so the zone's Email Address Obfuscation doesn't rewrite it into a `/cdn-cgi/l/email-protection#…`
  link that 404s for crawlers/no-JS visitors. Use it for every visible email address
  (footer, contact, privacy, sms-terms).
- `futurism-fx.tsx` — IntersectionObserver adds `.is-visible` to `.rise` elements; re-runs on route change.
- `public/fx.js` — defines the `<xl-dust>` custom element (canvas dust motes; `density` attr,
  default 36; colors from `--xl-light`/`--xl-sand`; respects `prefers-reduced-motion`).
  JSX typing in `src/types/custom-elements.d.ts`.

---

## 5. Backend (Next.js route handlers)

Auth is enforced per-route via `getSession()`. `src/middleware.ts` adds two cross-cutting
behaviors (§5.6): a CSRF origin/referer check on state-changing `/api/admin/*` calls, and
fire-and-forget page-view tracking beacons. Admin authorization is `isAdmin(email)` = membership
in the comma-separated `ADMIN_EMAIL` env allowlist — no DB role; `/admin` pages redirect
non-admins to `/login` (layout **and** each page), `/api/admin/*` routes use `requireAdmin()`
(401 no session / 403 not admin).
OAuth **callbacks** live under `/auth/...`, not `/api/auth/...` (they must match the redirect
URIs registered with Google/Microsoft).

### 5.1 `POST /api/tron-netter/chat` — web chat

- Body: `{messages: ChatMessage[], sessionId: string}`; 400 if either missing. Public (no visitor auth).
- Builds the brain envelope: system message = `getTronNetterSystemPrompt()` prepended to the
  visitor messages; `sessionId` passthrough; generated `promptId` (`tron_<base36 ts>_<rand>`);
  `memoryMode:"do_not_store"`; `disabledTools: await getDisabledBrainTools()`;
  `markdownMode:"html"`; `brainIdentity: TRON_NETTER_IDENTITY`; `groupName:"aiwebsite"`.
- Calls `POST ${BRAIN_BASE_URL}/v1/chat/completions` with Bearer, 120 s timeout.
- If the client sent `Accept: application/x-ndjson`, forwards that header to the brain and
  **re-emits a reduced NDJSON stream**, translating brain events → widget events:
  `token→token`, `answer_revised→answer`, `result→done(answer?)`, `error→error`; all internal
  brain events (`state`, `phase_progress`, model names) are stripped. Emits a synthetic `done`
  on flush if none was seen. Non-streaming fallback returns `{answer, sessionId}`.
- Brain non-200 → 502 `{error:"Tron Netter is temporarily unavailable"}`.

### 5.2 `POST /api/tron-netter/sms` — Twilio SMS webhook

- Parses `application/x-www-form-urlencoded` (`From`, `To`, `Body`).
- **Verifies `x-twilio-signature`**: base64(HMAC-SHA1 over `url + Σ sorted(key+value)`) with
  `TWILIO_AUTH_TOKEN`, compared via `timingSafeEqual`; the signed URL is
  `${NEXT_PUBLIC_BASE_URL}/api/tron-netter/sms`. Fail → 403.
- Opt-out/opt-in keywords (`stop stopall unsubscribe cancel end quit start unstop yes help info`)
  → empty TwiML `<Response/>` (Twilio handles compliance itself), no brain call.
- **ACK-then-work**: immediately returns empty TwiML (`text/xml`), then in Next's `after()`:
  1. Brain call (120 s), envelope: `sessionId: "sms-${from}"` (stable per sender → threading),
     system prompt = persona + `TRON_NETTER_SMS_ADDENDUM` (target <300 chars, ≤900),
     `requester:{requesterId: from}`, `privacyScope:"private_to_requester"`,
     `markdownMode:"strip"`, plus the standard `do_not_store`/`disabledTools`/`brainIdentity`/`groupName`.
  2. Reply via `sendSms()` from `lib/twilio.ts` (§5.5 — Twilio REST, Basic auth, body
     hard-capped `.slice(0,1200)`, 30 s). On brain failure sends a best-effort apology SMS.

### 5.3 `POST /api/webhooks/resend` — inbound email

- **Verifies Svix signature** with the `resend` SDK: `resend.webhooks.verify({payload: rawBody,
  headers: {svix-id, svix-timestamp, svix-signature}, webhookSecret: RESEND_WEBHOOK_SECRET})`;
  fail → 401. Only `event.type === "email.received"` is acted on; handler is fire-and-forget
  (Svix retries on slow responses); always returns `{ok:true}`.
- `handleInbound(emailId)`: fetches the full message via `resend.emails.receiving.get(emailId)`, then filters:
  - recipient (to/cc) must include `@ai.xl.net` — the Resend account also receives
    itsupportchicago.net traffic; drop `roleplay@` recipients too (that mailbox belongs to
    roleplay.xl.net's own webhook — answering would double-reply with two personas);
  - **loop guards**: drop if sender ends `@ai.xl.net`, contains `@itsupportchicago`, or matches
    `mailer-daemon|postmaster|no-?reply|donotreply`;
  - `stripQuotedAndSignature()` removes quoted history (`On … wrote:`, forwarded blocks, `>` lines,
    RFC-3676 `-- `) and the owner's signature **from the model prompt only** — the reply still
    quotes the full original.
- Brain call (**300 s** timeout): `sessionId: "email-${senderAddress}"`, system prompt = persona +
  `TRON_NETTER_EMAIL_ADDENDUM`, user msg `[Email from …]\nSubject: …\n\n<body>`,
  `requester:{requesterId, email}`, `privacyScope:"private_to_requester"`, `markdownMode:"strip"`,
  plus standard fields.
- Reply via `sendEmail()` (§5.6): subject `Re: …`, `replyTo: Tron.Netter@ai.xl.net`, body = answer
  + fixed signature block (name / AI Agent, XL.net / email / (872) 350-4325 — call or text /
  https://ai.xl.net) + quoted original. BCC to `adam@xl.net` applies as always.

### 5.4 OAuth (Google + Microsoft)

- `GET /api/auth/{google,microsoft}/start` — rate-limited **20/60 s per IP**
  (key `oauth_start:<ip>`; IP from `cf-connecting-ip` → first `x-forwarded-for` → `"unknown"`;
  429 when exceeded). Sets state cookie, redirects to the provider:
  - Google: `accounts.google.com/o/oauth2/v2/auth`, scope `openid email profile`,
    `access_type=online`, `prompt=select_account`. If `GOOGLE_CLIENT_ID/SECRET` unset →
    redirect `/login?error=provider_unconfigured`.
  - Microsoft: `login.microsoftonline.com/${MICROSOFT_TENANT_ID||"common"}/oauth2/v2.0/authorize`,
    scope `openid email profile User.Read`, `response_mode=query`. (No unconfigured guard.)
- `GET /auth/{google,microsoft}/callback` — validate state → exchange code
  (Google `oauth2.googleapis.com/token`; MS `…/oauth2/v2.0/token`) → fetch profile
  (Google `www.googleapis.com/oauth2/v3/userinfo`; MS `graph.microsoft.com/v1.0/me`, email =
  `mail || userPrincipalName`) → `handleOAuthUser()` (§5.5) → redirect to the validated
  `redirect` target or `/`. Every failure maps to a `/login?error=<code>` from §4's list.
- `GET /api/auth/session` → `{authenticated:false}` or
  `{authenticated:true, user:{email, displayName, provider, isAdmin, phone, smsOptIn,
  smsPromptEligible}}` (displayName/phone/smsOptIn refreshed from DB best-effort; `isAdmin` =
  email ∈ comma-separated `ADMIN_EMAIL`, case-insensitive; `smsOptIn` = `sms_opt_in_at` is set;
  `smsPromptEligible` = row read successfully && `!(phone && sms_opt_in_at)` &&
  `!sms_prompt_dismissed_at` — **defaults false on DB failure** so the prompt card fails
  toward silence, §5.8).
- `POST /api/auth/sms-prompt` (§5.8) — session-gated funnel/preference sink for the prompt card.
- `POST /api/auth/logout` → clears cookie, `{ok:true}`.
- `GET /api/health` → `{status:"ok"}` (used by PM2 readiness, watchdog, deploy verification).

### 5.5 `src/lib/` modules

| Module | Responsibility |
|---|---|
| `brain-client.ts` | `BRAIN_AUTH_HEADERS` (Bearer = first key in `BRAIN_API_KEYS`); `getDisabledBrainTools()` — `GET /v1/tools` (10 s), process-cached, fallback to the static `BRAIN_INTERNAL_TOOLS_FALLBACK` list. Routes construct their own `/v1/chat/completions` fetches (each channel's envelope and streaming needs differ) |
| `auth.ts` | Stateless HMAC session cookie **`aix_session`** (30 days): `base64url(JSON{userId,email,displayName,provider,iat,exp}).base64url(HMAC-SHA256(SESSION_COOKIE_SECRET))`; secret must be ≥32 chars (throws); httpOnly, sameSite lax, secure in prod; timing-safe verify; `isAdmin()` |
| `oauth-helpers.ts` | Cookies `aix_oauth_state` (32-byte hex) + `aix_oauth_redirect`, 600 s; redirect must start `/` and not `//` (open-redirect guard); `handleOAuthUser()` — lowercase email, upsert `users` (update lastLoginAt/displayName/provider or insert with emailDomain), set session, log to `auth_logs` |
| `db/index.ts` | drizzle over `postgres()` pool (max 20, idle 30 s, connect 10 s); lazy Proxy singleton; throws without `DATABASE_URL` |
| `db/schema.ts` | the 9 tables in §6 |
| `twilio.ts` | `sendSms(to, body, from?)` — Twilio REST `POST /2010-04-01/Accounts/{SID}/Messages.json` (Basic auth `sid:token`, form-encoded, body capped `.slice(0,1200)`, 30 s); `from` defaults to `TWILIO_PHONE_NUMBER`. Shared by the SMS webhook reply path (§5.2) and the /texting flow (§5.7) |
| `texting.ts` | `SMS_CONSENT_TEXT` (single source for the /texting checkbox **and** the `sms_consent_logs.consent_text` audit value), `VERIFICATION_CODE_TTL_MIN` = 10, `VERIFICATION_MAX_ATTEMPTS` = 5, `normalizeUsPhone()` (US/NANP → E.164 `+1XXXXXXXXXX` or null) |
| `email/send.ts` | `sendEmail()` via Resend REST `POST api.resend.com/emails` (Bearer, 10 s); default from `MAIL_FROM` = `Tron Netter <Tron.Netter@ai.xl.net>`; **always BCCs `OUTBOUND_BCC_EMAIL`** (default adam@xl.net) unless the recipient *is* that address (Resend rejects duplicates); no key → log + return false (email is best-effort) |
| `tron-netter/persona.ts` | `TRON_NETTER_IDENTITY` (brainName/personality/purpose/goals/originStory); SMS + email addenda; `BRAIN_INTERNAL_TOOLS_FALLBACK` (v1.91 tool-name snapshot); `getTronNetterSystemPrompt()` — reads `TRON_KNOWLEDGE_FILE` (default `<cwd>/data/tron-netter-knowledge.md`), **cached by mtime** so the nightly rewrite hot-reloads without restart; files <1000 chars treated as corrupt → baked-in `FALLBACK_PUBLIC_KNOWLEDGE`. Prompt enforces: first-person-plural "we", knowledge limited to the two sites, no tools/no internet, own line (872) 350-4325, human sales line +1 (844) 915-5155 |
| `rate-limit.ts` | in-memory Map limiter (per-process — adequate at 1 PM2 fork instance; **not distributed**, revisit if instances >1), lazy 60 s cleanup; `RATE_LIMITS`: `oauthStartPerIp {60s,20}`, `textingStartPerUser {600s,3}`, `textingStartPerPhone {600s,3}`, `textingVerifyPerUser {600s,10}`, `smsPromptPerUser {600s,20}` |
| `auth-guard.ts` | `requireAdmin()` for `/api/admin/*` handlers: `{ok:true, session}` or `{ok:false, response}` (401/403) |
| `brain-db.ts` | **read-only** admin queries over the brain's tables (`BRAIN_DB_TABLE_PREFIX`, default `brain_`): session lists/transcripts (`brain_messages`), usage totals/by-model (`brain_usage_events`), call log (`brain_phone_calls`), memory list/stats (`brain_memories`), distinct requesters. Channel inferred from sessionId prefix: `tron_`→chat, `sms-`→SMS, `email`→email. Brain timestamps are TEXT ISO-8601 (sort as text) |
| `admin/format.ts` | shared admin formatting: `fmtDate` (America/Chicago), `fmtBytes`, `fmtUsd`, `requesterLabel` (strips `email:` prefix) |
| `seo/classify-referrer.ts` | `classifyReferrer(referrer, utm)` → organic/direct/social/referral/email/paid; `extractDomain()`. Copied verbatim from itsupportchicago |
| `visitor-id/ip-org-resolver.ts` | `resolveIpOrg(ip)` via MaxMind GeoLite2-ASN (`MAXMIND_DB_PATH`, default `<cwd>/data/GeoLite2-ASN.mmdb`); results (incl. nulls) cached in `ip_orgs`; `visitor-id/isp-asns.ts` = static ISP/residential ASN set to filter non-attributable traffic. Missing .mmdb → resolver returns null, tracking unaffected |

### 5.6 Admin console (`/admin/*` + `/api/admin/*` + tracking)

Ported/adapted from itsupportchicago.net's admin. All pages: server components under the
shared `src/app/admin/layout.tsx` (nav + `robots: noindex,nofollow` + redirect guard),
`dynamic = "force-dynamic"`, styled with the futurism design system. Every data source
degrades independently (try/catch → empty state) so a missing table or stopped brain-api
never 500s the page.

| Page | Data | Notes |
|---|---|---|
| `/admin/analytics` | `users`, `auth_logs`, `page_visits`, brain usage | stat cards (users, 30d visits/sessions, 30d brain spend), usage-by-model table, recent sign-ins |
| `/admin/conversations` | `brain_messages` (read-only) | all channels; filter `?channel=chat\|sms\|email`, paginate `?offset`, transcript via `?session=<id>` |
| `/admin/messages` | Twilio REST API (no local storage) | client component; list is always scoped to `TWILIO_PHONE_NUMBER` (`To=`/`From=`) because the Twilio account is **shared with itsupportchicago**; "all" = merged first pages of both directions (no pagination), direction filters paginate via Twilio `next_page_uri`. Reply/compose form → `POST` |
| `/admin/mailbox` | `brain_messages` email sessions + `admin_emails` | thread list from email sessions; thread view merges Tron's turns with manual admin sends (matched by sessionId); compose/reply → `POST /api/admin/mailbox/send`; reply-to derived from requesterId, subject from the sessionId's thread slug |
| `/admin/calls` | `brain_phone_calls` (read-only) | expandable per-call transcripts (JSON `[{role,text}]`) |
| `/admin/contacts` | derived — no contacts table | merges OAuth users + brain requesters (SMS phones, `email:` addrs) + phone-call numbers into one directory (identifier, channels, interaction counts, first/last seen) |
| `/admin/companies` | `page_visits` ⋈ `ip_orgs` | orgs reading the site; ISP ASNs filtered out |
| `/admin/seo` | `page_visits` | 30-day first-party traffic: stat cards (views/sessions/visitors/bounce), source classification, referring domains, daily bars, top pages, session depth. **GSC/Semrush not wired up** |
| `/admin/knowledge` | `brain_memories` (read-only) | rows + per-source_type stats (row sizes matter — voice injects all public rows); button triggers the crawl |

API routes (all `requireAdmin()` + middleware CSRF):

- `GET/POST /api/admin/messages` — Twilio list proxy / send SMS (`From=TWILIO_PHONE_NUMBER`,
  To must be E.164, body ≤1600). Manual sends do NOT enter Tron's conversation history.
- `POST /api/admin/mailbox/send` — `sendEmail()` (Resend, mandatory adam@xl.net BCC), then
  records the send in `admin_emails` (success flag either way).
- `GET/POST /api/admin/knowledge/refresh` — status / spawn `scripts/refresh-tron-knowledge.mjs`
  detached (logs → `data/knowledge-refresh-manual.log`); module-level flag → 409 while running
  (not coordinated with the nightly cron).

**Page-view tracking:** `src/middleware.ts` (GET, non-API/non-admin/non-static paths, bot-UA
filtered, only when `INTERNAL_TRACK_SECRET` is set — fail-closed) POSTs
`{path, referrer, ip (cf-connecting-ip ∥ x-forwarded-for), userAgent, sessionHash =
hash(ip|ua|date), landingUrl, utm*}` fire-and-forget to `POST /api/internal/track`
(`x-track-secret` gated), which dedups same session+path within 30 s, inserts `page_visits`,
and warms `ip_orgs` via `resolveIpOrg()` in the background.

### 5.7 SMS opt-in & phone verification (`/texting` + `/api/texting/*`)

Verified (double) opt-in: possession of the phone is proven with a texted code before the
number ever touches `users`, and the exact consent language is archived per opt-in. Both
routes require a session (401 otherwise); constants and consent text live in `lib/texting.ts`.

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
  immutable `sms_consent_logs` row (`SMS_CONSENT_TEXT`, IP, user agent, page URL), and send
  a best-effort CTIA opt-in confirmation SMS in `after()` (frequency varies / msg&data rates
  / STOP / HELP).

Opt-**out** remains carrier-level: STOP/HELP keywords are handled by Twilio Advanced
Opt-Out before webhooks fire (§5.2); the site does not process them. `users.sms_opt_in_at`
is therefore "user opted in via /texting", not a live deliverability flag.

### 5.8 SMS prompt card (`<SmsPromptCard>` + `POST /api/auth/sms-prompt`)

Soft acquisition surface for §5.7, designed and design/architecture-audited 2026-07-09:
signed-in users with no registered number see a dismissible card (frontend behavior in §4)
pointing at `/texting`. Server pieces:

- Eligibility is computed **server-side** in `GET /api/auth/session` (`smsPromptEligible`,
  §5.4) — the client never derives it from raw fields, and a failed DB read suppresses the
  card rather than re-soliciting an opted-in user.
- `POST /api/auth/sms-prompt` — body `{event: "shown"|"clicked"|"snoozed"|"dismissed"}`;
  session required (401), rate-limited 20/10 min per user, 400 on unknown event. Appends to
  `sms_prompt_events` (funnel telemetry: card → click → `/texting?utm_source=sms_prompt`
  page visit → `sms_consent_logs` row = verified). `dismissed` additionally sets
  `users.sms_prompt_dismissed_at` **idempotently** (`WHERE … IS NULL`) — a UI preference,
  deliberately NOT written to `sms_consent_logs` (that table stays a pure consent audit).
  Lives under `/api/auth/*` (not `/api/texting/*`) because it is preference/telemetry,
  not consent. CSRF: sameSite=lax cookie + benign mutation, same posture as `/api/texting/*`.
- Client dismissal state: "Not now" is client-local (14-day localStorage snooze; the 3rd
  snooze auto-sends `dismissed`), "Don't ask again" is the server column so it holds across
  devices. A failed `dismissed` POST fails open (card may return next session) — acceptable
  for a preference write.

## 6. Database

One local **PostgreSQL** instance, one database **`aiwebsite`** (role `aiwebsite`, password
`aiwebsite` — dev/VM-local default; loopback only). **The site and the brain share this DB**;
brain tables carry the prefix **`brain_`** (`BRAIN_DB_TABLE_PREFIX`).

**Site tables** — drizzle-managed. `src/lib/db/schema.ts` is the single source of truth;
`drizzle/migrations/` is **gitignored by design** — setup-vm.sh regenerates and applies
migrations on every deploy (`npm run db:generate && npm run db:migrate`):

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
```

**Brain tables** — created at runtime by brain-api's own migration array on first boot
(~40 tables: `brain_messages`, `brain_memories`, `brain_goals`, `brain_usage_events`,
`brain_phone_calls`, …). Not managed by drizzle; never migrate them from the parent repo.
The parent **writes** exactly one directly: **`brain_memories`**
(columns used: `id, requester_id, group_id, scope, kind, key, value, importance, salience,
source_type, created_at, updated_at`) — written by the seed SQL and the nightly crawl.
The admin console additionally **reads** (never writes) `brain_messages`,
`brain_usage_events` and `brain_phone_calls` via `src/lib/brain-db.ts` (§5.6) — raw SQL,
resilient to the tables not existing yet.

**Persona seed** — `deploy/seed-tron-memories.sql`: idempotent upsert (fixed ids,
`ON CONFLICT (id) DO UPDATE`) of **7 public-scope rows** (`seed-tron-identity`, `seed-tron-scope`,
`seed-xlnet-company`, `-services`, `-results`, `-ai`, `-contact`). Applied by `setup-vm.sh` on
every deploy *after* brain-api is healthy (tables must exist). These rows are the persona's
evergreen identity on all channels and — critically — **the entire knowledge base for the voice
channel** (realtime voice sessions inject visible memories, not the prompt doc). The nightly
crawl never touches them (it only replaces `source_type='site_crawl'` rows).

---

## 7. The brain contract (what the site depends on)

The brain (submodule `packages/brain` ← `https://github.com/adampr/xldev.git`, v1.92) is a
generic "conversation-first, memory-bearing" engine. **The Tron Netter persona lives entirely
in the parent repo** — the brain receives it per-request via `brainIdentity` + a system message.
Rebuild the brain from its own canonical doc; the site needs only this contract:

### Endpoints consumed

| Endpoint | Auth | Used for |
|---|---|---|
| `POST /v1/chat/completions` | Bearer | all three site channels |
| `GET /v1/tools` | Bearer | enumerate tool names → send back as `disabledTools` |
| `GET /health` | none | readiness (`{ok:true, service:"brain-api", version}`), PM2/watchdog/deploy checks |
| `POST|GET /twilio/*` + WS `/twilio/ws` | Twilio signature | voice + carrier SMS — Twilio calls these directly through nginx; the site never does |

### Request envelope (fields this site sends)

```jsonc
{
  "sessionId": "tron_…| sms-+1312…| email-user@x.com",  // channel-stable → conversation threading
  "promptId": "tron_<base36ts>_<rand>",  // MANDATORY (400 without); idempotency key —
                                          // a retry with the same (sessionId,promptId) attaches
                                          // to the in-flight stream or replays the cached result
  "messages": [{"role":"system","content":"<persona+knowledge>"}, …visitor msgs],
  "brainIdentity": { "brainName":"Tron Netter", "personality":…, "purpose":…, … },
  "groupName": "aiwebsite",
  "memoryMode": "do_not_store",           // public channels never write memories
  "privacyScope": "private_to_requester", // SMS + email only
  "requester": {"requesterId": "<phone|email>"},  // SMS + email only
  "markdownMode": "html" /* chat */ | "strip" /* sms, email */,
  "disabledTools": ["memory_lookup","web_search",…]   // full list from GET /v1/tools
}
```

Non-streaming response is OpenAI-compatible; the site reads `choices[0].message.content`.
With `Accept: application/x-ndjson` the brain streams NDJSON events (each tagged with
`promptId`): `state`, `token{text}`, `phase_progress`, `answer_revised{text}`, `result{…full
payload}`, `error`. The site's chat route filters this down to the widget's 4-event protocol (§5.1).

### Brain runtime facts that matter to this deployment

- Express 5, run as TypeScript directly via the submodule's own `tsx` — **no build step**.
- Storage backend is selectable: default SQLite (`~/software-brain-data/brain.sqlite`), but
  **this deployment runs `BRAIN_DB_BACKEND=postgres`** against the shared DB with prefix
  `brain_` (Postgres duck-types the sync better-sqlite3 API via `pg-native` → needs `libpq-dev`
  + build tools at `npm ci` time).
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

---

## 8. Knowledge pipeline (nightly crawl)

`scripts/refresh-tron-knowledge.mjs` — plain Node ESM, only dep `postgres` (dynamic import).

- **Crawl**: 100 % of HTML pages on `https://xl.net` and `https://ai.xl.net`. Seeds from each
  origin's `/sitemap.xml` (follows sitemap indexes, ≤20 children) **plus** a full same-host link
  walk. 4 workers, 250 ms delay each, 20 s fetch timeout, cap `MAX_PAGES_PER_SITE=1000`
  (loudly reported if hit), UA `TronNetterKnowledgeBot/1.0`. URL normalization: https, strip
  www/query/fragment/trailing slash; assets skipped by extension; pages deduped by SHA-1 of
  extracted text. HTML→text strips head/script/style/nav/header/footer/form.
- **Three sinks, REPLACE semantics (never append)**:
  1. `brain_memories` `source_type='site_crawl'` — one ≤500-char summary row per page,
     upsert current + delete stale, in one transaction (via `BRAIN_POSTGRES_URL` ∥
     `DATABASE_URL`). Core pages importance 0.9, archives 0.6. Feeds all channels incl. voice.
  2. `data/tron-netter-knowledge.md` — the prompt doc, budget 175 000 chars
     (`PROMPT_KNOWLEDGE_MAX_CHARS`): core-first ordering (ai.xl.net → service pages → archives),
     full text for pages that fit + compact index for the rest. Hot-reloaded by persona.ts on mtime.
  3. `data/tron-netter-knowledge-full.md` — complete crawl, audit only.
  Files written atomically (tmp + rename, 0644).
- **Safety**: aborts and keeps yesterday's knowledge if any site yields 0 pages or combined
  text <5000 chars → FAILED email.
- **Report email** via Resend from `ai.xl.net Knowledge Refresh <noreply@ai.xl.net>` to
  `KNOWLEDGE_NOTIFY_EMAIL` ∥ `ADMIN_EMAIL` ∥ `adam@xl.net`: duration, pages/words/KB per site,
  sink outcomes, warnings, ≤15 fetch errors; subject OK / PARTIAL (memory sink failed) / FAILED.
- **Schedule**: root cron `0 8 * * *` (08:00 UTC = 3 am Chicago) →
  `/var/log/aiwebsite-tron-knowledge.log`; also run once per deploy with `--no-email`.

---

## 9. Deployment & operations

### 9.1 Deploy flow (`deploy/deploy.sh`, run from the dev box)

1. Reads `AIWEBSITE_SSH_IP` / `AIWEBSITE_USER` / `AIWEBSITE_PW` **literally** from `.env`
   (not sourced — passwords may contain shell metachars); uses `sshpass`.
2. `rsync -az --delete` repo → `/var/www/aiwebsite`, **excluding** `.git`, `node_modules`,
   `.next`, brain caches, `.env`, and `/data/` (VM-generated knowledge must survive the delete).
3. rsync the production `.env` separately; ship `data/GeoLite2-ASN.mmdb` explicitly if
   present locally (it lives inside the excluded `/data/`); ship
   `~/.cloudflared/aiwebsite-tunnel.json` → `/etc/cloudflared/` (0600) if present.
4. SSH → run `deploy/setup-vm.sh` (below).
5. Verify `127.0.0.1:3000/api/health`, `127.0.0.1:3211/health`, then public
   `https://ai.xl.net/api/health`.

### 9.2 VM provisioning (`deploy/setup-vm.sh`, idempotent)

APT `build-essential python3 libpq-dev pkg-config jq rsync` → Node 22 (nodesource) + PM2 →
PostgreSQL (create role+db `aiwebsite`, guarded) → nginx config (below) →
`npm ci --include=dev` (site **and** `packages/brain` — the VM environment omits devDependencies
by default, and the build needs drizzle-kit/typescript/tailwind) → `db:generate` + `db:migrate` →
`rm -rf .next/cache` (stale Turbopack cache from a previous next version breaks module
resolution; only the cache — the built output is swapped atomically while pm2 serves it) →
`next build` → `pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save && pm2 startup systemd`
→ wait ≤60 s for brain `/health` → `psql -f deploy/seed-tron-memories.sql` → install knowledge
cron + initial crawl `--no-email` → `setup-cloudflared.sh` → install watchdog (+cron) and start it.

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
  restart skills-host · `:3000/api/health` `"status":"ok"` → restart aiwebsite.
- Every 5th pass: renders `/`, `/contact`, `/login`; on 5xx / "application error" /
  NEXT_NOT_FOUND / timeout → clean `npm run build` (1024 MB heap; **no** `rm -rf .next` — Next
  swaps builds atomically) + restart + re-verify.
- Alerts via Resend to adam@xl.net from `ai.xl.net Watchdog <noreply@ai.xl.net>`, throttled
  1 email / unique issue / 24 h (`/tmp/aiwebsite-watchdog-throttle`).
- `watchdog-cron.sh` (root cron `*/5 * * * *`) relaunches the loop if its PID is dead
  (verifies `/proc/PID/cmdline`).

**Root crontab summary:** `0 8 * * *` knowledge refresh · `*/5 * * * *` watchdog supervisor.

---

## 10. Environment variables (single shared `.env`, site + brain + deploy)

Generate secrets with `openssl rand -hex 32`. `.env.example` is the authoritative template —
every variable below appears there with a comment.

| Group | Var | Value / purpose |
|---|---|---|
| DB | `DATABASE_URL` | `postgresql://aiwebsite:aiwebsite@localhost:5432/aiwebsite` (site; throws if unset) |
| Brain | `BRAIN_BASE_URL` | `http://127.0.0.1:3211` |
| | `BRAIN_API_KEYS` | comma list; **set in prod** (brain v1.92 fail-closed); site uses first key as Bearer |
| | `BRAIN_PUBLIC_URL` | **exactly** `https://ai.xl.net/brain` (Twilio signature base) |
| | `BRAIN_DB_BACKEND` / `BRAIN_POSTGRES_URL` / `BRAIN_DB_TABLE_PREFIX` | `postgres` / same DB as site / `brain_` |
| | `BRAIN_AUDIO_MODE` | `xai_realtime` |
| LLMs | `OPENAI_API_KEY`, `OPENAI_MODEL` (gpt-5-mini), `BRAIN_FIRST_PASS_MODEL` (gpt-5.4-mini), `OPENAI_TTS_MODEL` (tts-1), `OPENAI_STT_MODEL` (whisper-1) | brain chat/voice |
| | `XAI_API_KEY` | realtime voice (calls drop without it) |
| | `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `TAVILY_API_KEY`, `AA_API_KEY` | optional brain providers |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_PHONE_NUMBER` | number +1 872 350 4325, SID `PN9435882fd720d7ec79108d195f4c9e39`; same number sends the /texting verification codes (§5.7) |
| | `INBOUND_PHONE_PERSONA_NAME` / `INBOUND_PHONE_SITE` / `INBOUND_PHONE_GREETING` | voice persona (Tron Netter / ai.xl.net) |
| Email | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (svix inbound), `MAIL_FROM` (`Tron Netter <Tron.Netter@ai.xl.net>`), `CONTACT_NOTIFY_EMAIL`, `OUTBOUND_BCC_EMAIL` (default adam@xl.net — mandatory oversight BCC) | ai.xl.net domain verified in Resend |
| Auth | `SESSION_COOKIE_SECRET` (≥32 chars), `ADMIN_EMAIL` (comma list — gates `/admin` + `/api/admin/*`, currently adam@xl.net) | |
| Admin | `INTERNAL_TRACK_SECRET` | auth for middleware→`/api/internal/track` beacons; unset = visit tracking off (SEO/Companies pages stay empty) |
| | `MAXMIND_DB_PATH` | optional; default `<cwd>/data/GeoLite2-ASN.mmdb` (IP→org for /admin/companies) |
| | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | `https://ai.xl.net/auth/google/callback` (GCP project `xl-website-1682362315172`, client "ai.xl.net") |
| | `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_REDIRECT_URI` / `MICROSOFT_TENANT_ID` (default `common`) | Entra app `e66a2e8f-c1c1-4b63-9ffe-245db7d5363c` |
| Site | `NEXT_PUBLIC_BASE_URL` (`https://ai.xl.net`), `NEXT_PUBLIC_SITE_NAME` (`XL.net AI`) | |
| | `TRON_KNOWLEDGE_FILE` | optional override; default `<cwd>/data/tron-netter-knowledge.md` |
| Crawl | `KNOWLEDGE_NOTIFY_EMAIL` / `ADMIN_EMAIL` | report recipient fallbacks |
| Misc | `AUTOMATION_SECRET` (skills-host), `DEFAULT_BRAIN_NAME`, `DEFAULT_PURPOSE` | brain persona defaults |
| Deploy | `AIWEBSITE_SSH_IP` (52.237.160.75), `AIWEBSITE_USER` (xladmin), `AIWEBSITE_PW` | consumed only by deploy.sh on the dev box |

---

## 11. External accounts required for a rebuild

| Service | What must exist |
|---|---|
| **Cloudflare** (xl.net zone) | Tunnel `aiwebsite` + credentials JSON; CNAME `ai` → `<tunnel-id>.cfargotunnel.com`, Proxied. DNS edits are human-only |
| **Twilio** | Number +1 (872) 350-4325 ("Tron Netter - XL.net AI"); voice webhooks → `https://ai.xl.net/brain/twilio/voice/{inbound,fallback,status}`; SMS webhook → `https://ai.xl.net/api/tron-netter/sms`; account SID/token + API key pair |
| **Resend** | Domain `ai.xl.net` verified (send); inbound routing for `Tron.Netter@ai.xl.net` → webhook `https://ai.xl.net/api/webhooks/resend` (svix secret). Account is shared with itsupportchicago.net — hence the domain filter in §5.3 |
| **Google Cloud** | OAuth consent screen "XL.net AI" (External, published) + web client "ai.xl.net", redirects `https://ai.xl.net/auth/google/callback` and `http://localhost:3000/auth/google/callback`. Manual console work — see `deploy/GOOGLE-OAUTH-SETUP.md` |
| **Microsoft Entra** | App `e66a2e8f-c1c1-4b63-9ffe-245db7d5363c` (creatable via `az ad app create`), redirect `https://ai.xl.net/auth/microsoft/callback` |
| **OpenAI / xAI / Anthropic / Deepgram / Tavily** | API keys per §10 |
| **Azure VM** | Ubuntu-family box, ssh password auth for deploy.sh (hardening note in GO-LIVE.md: switch to keys) |

---

## 12. Cleanroom rebuild order

1. **Repo + submodule**: scaffold per §3; `git submodule add https://github.com/adampr/xldev.git packages/brain`.
2. **DB layer**: schema.ts (§6) → `db:generate` → migrations.
3. **Site**: layout/design system (§4) → pages → lib modules (§5.5) → API routes (§5.1–5.4)
   → chat widget. Test chat against a locally-booted brain (`npm run bootstrap` inside the
   brain; SQLite backend is fine for dev).
4. **Persona**: `persona.ts` + a hand-written starter `data/tron-netter-knowledge.md`
   (>1000 chars) until the crawler exists.
5. **Crawler** (§8): run manually with `--no-email`, verify the three sinks.
6. **Deploy layer** (§9): nginx → ecosystem/pm2-start → setup-vm → setup-cloudflared →
   watchdog → deploy.sh. Provision external accounts (§11), assemble `.env` (§10).
7. **Go live**: deploy, seed memories, DNS CNAME (human), point Twilio + Resend webhooks at
   the public URLs, verify all four channels: page render, chat stream, SMS round-trip,
   email round-trip, voice call.

## 13. Verification checklist (post-deploy)

```
curl -s https://ai.xl.net/api/health            # {"status":"ok"}
curl -s http://127.0.0.1:3211/health            # {"ok":true,"service":"brain-api",...}   (on VM)
curl -s http://127.0.0.1:3213/health            # skills-host ok                          (on VM)
pm2 ls                                          # aiwebsite / brain-api / skills-host online
journalctl -u cloudflared -n 20                 # tunnel connected
psql -c "select count(*) from brain_memories where scope='public'"   # ≥7 seed rows
```
Then: chat widget streams tokens; text the Twilio number and get a reply <1200 chars; email
Tron.Netter@ai.xl.net and get a reply (BCC lands at adam@xl.net); call the number. Sign in
as adam@xl.net → the user menu shows "Admin"; `/admin/conversations` lists the test
exchanges above and `/admin/seo` starts counting visits (needs `INTERNAL_TRACK_SECRET`).
Sign in and register a number at `/texting`: the 6-digit code arrives by SMS, verifying it
sets `users.phone` + adds an `sms_consent_logs` row, and a confirmation text follows.

Common failures (from GO-LIVE.md): Twilio 403 → `BRAIN_PUBLIC_URL` not exactly
`https://ai.xl.net/brain`; calls drop → `XAI_API_KEY`; brain 503 → `OPENAI_API_KEY`;
tunnel up but 502 → nginx or PM2 down.

---

## 14. Design review personas

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
