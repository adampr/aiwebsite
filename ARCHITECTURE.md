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

Last verified against code: 2026-07-10 (brain submodule v1.92, @aicompany/core v0.1.0,
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
has optional Google/Microsoft OAuth sign-in (§5.4) — purely additive; no page requires login.
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
├── site.config.ts              the whole host↔module interface (@aicompany/core §4):
│                               persona identity/prompt rules, channel copy, texting consent,
│                               memory voice, admin nav, oversight, privacy retention, crawl
│                               origins — every visitor-facing value ported VERBATIM from the
│                               legacy code (parity baseline, module MIGRATIONS.md)
├── instrumentation.ts          host-written register(): imports src/lib/db (table registry),
│                               then runs the module's runtimeCheck(siteConfig) (§4.3 layer 2)
├── src/                        Next.js 16 App Router source (§5)
│   ├── app/                    pages + thin wrapper routes over @aicompany/core (§5.1)
│   ├── components/             host-only components (email-link, futurism-fx)
│   ├── lib/db/                 composed schema (module factories + host tables) + db wrapper
│   └── types/                  custom-element JSX typings
├── packages/brain/             git submodule ← https://github.com/adampr/xldev.git (§7)
├── packages/aicompany/         git submodule ← https://github.com/adampr/aicompany.git —
│                               @aicompany/core v0.1.0, installed as a file: dependency;
│                               channels, auth, admin, tracking, texting, memory, SEO,
│                               crawler, deploy templates (its own architecture.md is canonical)
├── data/                       VM-GENERATED knowledge files — gitignored from deploy --delete,
│   │                           rewritten nightly by the crawl (§8); never hand-edit
│   ├── tron-netter-knowledge.md        (~175 KB budgeted prompt doc, read at request time)
│   ├── tron-netter-knowledge-full.md   (~2.5 MB full crawl, audit only)
│   ├── aiwebsite-config.json           JSON config snapshot for the crawler (re-rendered at
│   │                                    deploy + by the knowledge timer's ExecStartPre)
│   └── GeoLite2-ASN.mmdb               MaxMind IP→ASN db (12 MB, gitignored; deploy.sh ships it
│                                        explicitly; shared copy with itsupportchicago) (§5.6)
├── scripts/                    ai-provider-health.mjs (§9.6); refresh-tron-knowledge.mjs is the
│                               LEGACY crawler — deploy now wires the module's crawler (§8)
├── deploy/                     site-deploy.env + files RENDERED from the module's
│                               deploy/templates (stamped; §9) + host extras (GO-LIVE.md,
│                               GOOGLE-OAUTH-SETUP.md, generated seed-persona-memories.sql)
├── drizzle/migrations/         committed migration history (introspected baseline + diffs, §6)
├── drizzle.config.ts           schema ./src/lib/db/schema.ts → ./drizzle/migrations, dialect postgresql
├── public/                     favicons, brand assets, fx.js (<xl-dust> canvas particles)
├── next.config.ts              trailingSlash:false; experimental.inlineCss:true;
│                               transpilePackages:["@aicompany/core"]
├── postcss.config.mjs          single plugin: @tailwindcss/postcss
└── tsconfig.json               strict, bundler resolution, alias @/* → ./src/*, excludes packages/brain
```

**Stack versions:** Node **22** (VM; brain requires ≥20) · Next.js **16.2.9** · React **19.2.4**
· TypeScript 5 · Tailwind **v4** · drizzle-orm 0.45 + `postgres` 3.4 driver · resend 6.17
· maxmind 5 + mmdb-lib (IP→org for /admin/companies).
`src/middleware.ts` is the module's tracking/CSRF middleware wrapper (§5.6). Module tooling via
`package.json` scripts: `config:check`, `doctor`, `simulate:sms`, `simulate:email`,
`upgrade:check`. No test suite in the parent repo (the module and brain have their own).

---

## 4. Frontend

Six public pages, all served from the root layout (`src/app/layout.tsx`), plus the
admin console under `/admin/*` (§5.6):

| URL | Type | Content |
|---|---|---|
| `/` | static server component | Marketing home: hero with `<xl-dust>` particle canvas, theme-aware animated logo iframes (`/brand/xl-logo-animated-{dark,light}.html`), stat cards (79.8% issue reduction, 24/7, 99.3% CSAT), capability panels, CTA → `/contact` |
| `/contact` | static server component | Contact info only — **no form** (email `Tron.Netter@ai.xl.net`, phone/SMS (872) 350-4325, points users at the chat widget); links to `/texting` |
| `/login` | client component | Sign-in card in `<Suspense>`; reads `?redirect`, `?error`, `?message`; links to `/api/auth/{google,microsoft}/start`; error codes map to friendly text via the module's `loginErrorMessages` (`@aicompany/core/auth/login-errors`), `?message` taking precedence. `login/layout.tsx` sets `robots: noindex` |
| `/texting` | server component shell + module client wizard | Page shell (heading + footnote) kept from the legacy page; the wizard itself is the module's `<TextingWizard {...toTextingWizardProps(siteConfig)}/>`: session check → phone + consent checkbox (`texting.consentText` + links to the legal pages) → 6-digit code entry (resend / change-number) → "Verified" panel. Signed-out users get a Sign In link with `?redirect=/texting`; already-opted-in users land on the done state. `texting/layout.tsx` holds the metadata |
| `/privacy` | thin wrapper (server component) | Renders the module's `<PrivacyPolicyPage config={siteConfig} lastUpdated="July 2026"/>` — the policy is generated from the same config values the code enforces (tracking flags, cookie name, retention windows, enabled channels). Keeps the page's own `metadata` export |
| `/sms-terms` | thin wrapper (server component) | Renders the module's `<SmsTermsPage config={siteConfig} lastUpdated="July 2026"/>` — program description, opt-in methods, verification mechanics from `texting.verification`, frequency/rates, STOP/HELP, carriers, privacy cross-link, contact. Keeps the page's own `metadata` export |

The footer links Home, Contact, Text with Tron Netter (`/texting`), Privacy Policy, SMS
Terms, and the main xl.net site.

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
- `futurism-fx.tsx` — IntersectionObserver adds `.is-visible` to `.rise` elements; re-runs on route change.
- `public/fx.js` — defines the `<xl-dust>` custom element (canvas dust motes; `density` attr,
  default 36; colors from `--xl-light`/`--xl-sand`; respects `prefers-reduced-motion`).
  JSX typing in `src/types/custom-elements.d.ts`.

---

## 5. Backend (Next.js route handlers)

Every channel/auth/admin/tracking handler is **provided by @aicompany/core v0.1.0** and
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
| `POST /api/webhooks/resend` | `createInboundEmailHandler` · `channels/email` | §5.3 |
| `GET /api/auth/google/start` / `GET /auth/google/callback` | `createOAuthStartHandler` / `createOAuthCallbackHandler` · `auth/oauth-google` | §5.5 |
| `GET /api/auth/microsoft/start` / `GET /auth/microsoft/callback` | same pair · `auth/oauth-microsoft` | §5.5 |
| `GET /api/auth/session` | `createSessionHandler` · `auth/handlers` | §5.5 |
| `POST /api/auth/logout` | `createLogoutHandler` · `auth/handlers` | §5.5 |
| `GET /api/health` | `createHealthHandler` · `auth/handlers` | §5.5 |
| `POST /api/texting/start` / `POST /api/texting/verify` | `createTextingStartHandler` / `createTextingVerifyHandler` · `channels/texting` | §5.10 |
| `POST /api/auth/sms-prompt` | `createSmsPromptEventHandler` · `channels/texting` | §5.10 |
| `POST /api/internal/track` | `createTrackHandler` · `tracking/track-api` | §5.6 |
| `src/middleware.ts` | `createTrackingMiddleware` · `tracking/middleware` | §5.6 |
| `GET/POST /api/admin/messages` | `createAdminMessagesHandler` · `admin/api` | §5.6 |
| `POST /api/admin/mailbox/send` | `createAdminMailboxSendHandler` · `admin/api` | §5.6 |
| `GET/POST /api/admin/knowledge/refresh` | `createAdminKnowledgeRefreshHandler` · `admin/api` (wrapper adds `runtime = "nodejs"`) | §5.6 |
| `/admin/<key>` pages + layout | module admin page components + `<AdminLayout>` | §5.6 |
| `src/app/sitemap.ts` / `robots.ts` | `createSitemap(siteConfig, entries)` / `createRobots` · `seo/*` | §5.9 |

Not mounted (disabled features): magic-link auth (`auth.providers.magicLink: false`).

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
  copy verbatim).
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
disclosure, reply via Twilio REST capped at 1200 chars. aiwebsite facts:

- Number **+1 (872) 350-4325** (`channels.sms.phoneNumber`), shared Twilio account with
  itsupportchicago (admin views stay number-scoped, §5.6).
- Legacy keyword list partitioned per the module contract: `optOutKeywords`
  `stop stopall unsubscribe cancel end quit` (carrier compliance replies come from the
  Messaging Service's Advanced Opt-Out) + `silentKeywords` `start unstop yes help info`
  (short-circuited with no reply — aiwebsite parity).
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
- Memory gate pins `memory.emailAuthservId: "resend.com"`, `allowSpfOnly: false`
  (DKIM-aligned only). **Run the go-live probe**: send a real Gmail message + a spoofed one
  (`swaks --from victim@gmail.com` from an unrelated host) and read the logged auth-verdict
  lines; correct `emailAuthservId` if Resend stamps a different authserv-id — if it stamps
  none, email memory silently stays off (fail-closed, by design).
- Reply signature: name / AI Agent, XL.net / mailbox / (872) 350-4325 — call or text / the
  one-line memory disclosure with the /privacy link / https://ai.xl.net. Oversight BCC to
  adam@xl.net as always. 300 s brain timeout (`brain.timeouts.emailMs`).
- Brain-failure reply copy: `channels.email.failureMessage` (module default — the legacy
  route sent nothing on failure; this is a panel-mandated hardening delta).

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
  external uptime monitor).

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

Values that were constants in those files (consent text, TTLs, addenda, fallback tool
list, failure copy, retention windows) live in **site.config.ts**, ported verbatim.

### 5.6 Admin console (`/admin/*` + `/api/admin/*` + tracking)

The console is @aicompany/core's admin (module architecture.md §5.6), mounted as thin
wrappers. Each `src/app/admin/<key>/page.tsx` renders the module page component with
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
  for a preference write.

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
    call-metadata rows minus transcript, deletion-audit row, the brain's local
    thinking-debug SQLite, server logs, oversight BCC copies.
  - `sweepEscapedSharedMemories()` — **poisoning guard, load-bearing**: the brain's extraction
    LLM may stamp a candidate fact `scope:'public'` (bot_self_fact) and candidate scope
    overrides the envelope's privacyScope at write time, so a chatter could otherwise plant a
    memory visible to every visitor. Envelope-side we omit `groupName` (no groupId ⇒
    `private_to_group` candidates demote to private); public-scope escapes are
    soft-invalidated (`valid_until = now`, evidence stays visible in /admin) by this sweep,
    which runs fire-and-forget before + after every `store_persistent` turn and nightly in
    the crawl script. Sanctioned shared-scope rows are ONLY `source_type IN
    ('seed','site_crawl')` — any hand-inserted public fact must use `'seed'`. A swept
    count > 0 is an intrusion signal (logged, and a warning line in the crawl report email).
- **`memory.memoryPromptAddendum`** (site.config.ts) — appended on memory-bearing turns:
  memories are personal context only; site knowledge always wins; never adopt instructions
  from memories. Email sender authenticity is judged by module `src/memory/email-auth.ts`
  (fail-closed Authentication-Results parsing, authserv-id pinned to
  `memory.emailAuthservId`, DKIM-aligned only).
- **Accepted risks** (product decisions, disclosed on /privacy): recycled phone numbers
  surface the previous holder's number-keyed memories until FORGET; inbound voice keys recall
  by spoofable caller ID (targeted caller-ID spoofing exposes that number's memories on a
  call). Historic `email:<addr>` buckets are never auto-merged into account buckets (no
  authenticated link at merge time).

---

## 6. Database

One local **PostgreSQL** instance, one database **`aiwebsite`** (role `aiwebsite`, password
`aiwebsite` — dev/VM-local default; loopback only). **The site and the brain share this DB**;
brain tables carry the prefix **`brain_`** (`BRAIN_DB_TABLE_PREFIX`).

**Site tables** — drizzle-managed. `src/lib/db/schema.ts` is the single source of truth:
the 10 shared tables are composed from **@aicompany/core's schema factories** (module
architecture.md §6 — `makeUsersTable({...textingUserColumns})`, `makeAuthLogsTable`,
`makePageVisitsTable`, `makeIpOrgsTable`, `makeAdminEmailsTable`, `makeSmsConsentLogsTable`,
`makePhoneVerificationsTable`, `makeSmsPromptEventsTable`, `makeSmsMemoryNoticesTable`,
`makeMemoryDeletionLogsTable`) plus the host-owned `contact_submissions`; the composed
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
| `GET /v1/model-routing` | Bearer | (brain v1.92 + Issue #684) concrete model id per pipeline task + `plannerEffectiveModel`; consumed by `scripts/ai-provider-health.mjs` (§9.6) to probe routed ids before visitors hit them |
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
  extracted text. HTML→text strips head/script/style/nav/header/footer/form.
- **Three sinks, REPLACE semantics (never append)**:
  1. `brain_memories` `source_type='site_crawl'` — one ≤500-char summary row per page,
     upsert current + delete stale, in one transaction (via `BRAIN_POSTGRES_URL` ∥
     `DATABASE_URL`). Core pages importance 0.9, archives 0.6. Feeds all channels incl. voice.
     Followed by the **nightly poisoning-sweep backstop** (§5.9): soft-invalidate shared-scope
     rows with `source_type NOT IN ('seed','site_crawl')`; swept count > 0 → warning line in
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
2. Transport per `site-deploy.env`: currently **`sshpass`** (the VM still uses password
   auth — `AIWEBSITE_SSH_IP`/`AIWEBSITE_USER`/`AIWEBSITE_PW` read **literally** from
   `.env`, never sourced), which deploy.sh refuses to run without an explicit
   `--allow-sshpass` flag. Recommended switch: provision a key, set `AIWEBSITE_SSH_KEY`,
   flip `DEPLOY_TRANSPORT=ssh-key`, re-render. (A `gcloud-iap` variant exists for GCP.)
3. `rsync -az --delete` repo → `/var/www/aiwebsite`, **excluding** `.git`, `node_modules`,
   `.next`, brain caches, `.env`, and `/data/` (VM-generated knowledge must survive the delete).
4. rsync the production `.env` separately; ship `data/GeoLite2-ASN.mmdb` explicitly if
   present locally (it lives inside the excluded `/data/`); ship
   `~/.cloudflared/aiwebsite-tunnel.json` → `/etc/cloudflared/` (0600) if present.
5. SSH → run `deploy/setup-vm.sh` (below).
6. Verify `127.0.0.1:3000/api/health`, `127.0.0.1:3211/health`, then public
   `https://ai.xl.net/api/health`.

### 9.2 VM provisioning (`deploy/setup-vm.sh`, idempotent)

APT `build-essential python3 libpq-dev pkg-config jq rsync logrotate` → Node 22
(nodesource) + PM2 (+ `pm2-logrotate` 10 M/retain 7) → PostgreSQL (create role+db
`aiwebsite`, guarded; `max_wal_size=256MB`) → nginx config (below) →
`npm ci --include=dev` (site **and** `packages/brain`) → `db:migrate` (committed history —
no `db:generate` on the VM anymore) → generate `deploy/seed-persona-memories.sql` from
site.config.ts (§6) → **`npm run config:check`** (config↔env cross-validation incl.
`BRAIN_PUBLIC_URL === baseUrl + "/brain"`, brain version range, schema registry — **gates
the build/reload**: a bad config aborts before PM2 is touched) → `rm -rf .next/cache`
(stale Turbopack cache breaks module resolution; only the cache — built output swaps
atomically) → `next build` → `pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save &&
pm2 startup systemd` → wait ≤60 s for brain `/health` → `psql -f
deploy/seed-persona-memories.sql` → render `data/aiwebsite-config.json` + install the
**five systemd timers** (§9.7) → initial crawl `--no-email` → `setup-cloudflared.sh` →
install watchdog + cron supervisor and (re)start it.

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
  **freshness checks**: backup heartbeat `/var/lib/aiwebsite/last-backup-ok` and the
  knowledge doc's mtime (path from the `data/aiwebsite-config.json` snapshot) — either
  >26 h old → alert.
- Every 5th pass: renders `/` and `/login`; on 5xx / "application error" /
  NEXT_NOT_FOUND / timeout → clean `npm run build` (1024 MB heap; **no** `rm -rf .next` — Next
  swaps builds atomically) + restart + re-verify.
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

Installed/enabled by setup-vm.sh; scripts installed to `/usr/local/bin/aiwebsite-*`;
verify with `systemctl list-timers 'aiwebsite-*'` (all 5):

| Timer | Schedule (UTC) | Does |
|---|---|---|
| `aiwebsite-knowledge` | daily 08:00 | nightly crawl (§8); `ExecStartPre` re-renders `data/aiwebsite-config.json` |
| `aiwebsite-backup` | daily 07:15 | `backup-db.sh`: `pg_dump aiwebsite \| gzip` → `$BACKUP_BUCKET` (+ `latest.sql.gz`), refuses <500 MB free disk, rejects dumps <100 KB, 30-day bucket retention, stamps the heartbeat the watchdog checks. **BACKUP_BUCKET is currently EMPTY** — no bucket exists for aiwebsite yet, so every run fails loudly (`[aiwebsite] CRITICAL Database backup FAILED` nightly) until one is provisioned (go-live TODO in site-deploy.env; Azure Blob `azblob://…` is the natural fit — the VM is Azure) |
| `aiwebsite-restore-drill` | quarterly (Jan/Apr/Jul/Oct 5th, 06:30) | restores `latest.sql.gz` into a scratch DB, sanity-checks row counts, drops it, emails pass/fail either way — a backup that cannot be restored is not a backup |
| `aiwebsite-retention-sweeper` | weekly Sun 05:30 | deletes `page_visits` >730 d, `auth_logs` >365 d, `ip_orgs` >730 d, `admin_emails` >730 d — **must match `privacy.retentionDays`** in site.config.ts (sms_consent_logs exempt by design) |
| `aiwebsite-disk-check` | daily 06:45 | alert at >80 % disk on `/` |

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
| | `BRAIN_API_KEYS` | comma list; **set in prod** (brain v1.92 fail-closed); site uses first key as Bearer |
| | `BRAIN_PUBLIC_URL` | **exactly** `https://ai.xl.net/brain` (Twilio signature base) |
| | `BRAIN_DB_BACKEND` / `BRAIN_POSTGRES_URL` / `BRAIN_DB_TABLE_PREFIX` | `postgres` / same DB as site / `brain_` |
| | `BRAIN_AUDIO_MODE` | `xai_realtime` |
| LLMs | `OPENAI_API_KEY`, `OPENAI_MODEL` (gpt-5-mini), `BRAIN_FIRST_PASS_MODEL` (gpt-5.4-mini), `OPENAI_TTS_MODEL` (tts-1), `OPENAI_STT_MODEL` (whisper-1) | brain chat/voice |
| | `XAI_API_KEY` | realtime voice (calls drop without it) |
| | `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `TAVILY_API_KEY`, `AA_API_KEY` | optional brain providers |
| | `GOOGLE_GEMINI_API_KEY` | Google AI Studio key (set 2026-07-10) — enables the brain's Gemini planner (`gemini-3.1-pro-preview`) + google models in the router; if it ever fails, the planner falls back to OpenAI (brain Issue #684). NOTE: the brain reads exactly this name, not `GEMINI_API_KEY` |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_PHONE_NUMBER` | number +1 872 350 4325, SID `PN9435882fd720d7ec79108d195f4c9e39`; same number sends the /texting verification codes (§5.7) |
| | `INBOUND_PHONE_PERSONA_NAME` / `INBOUND_PHONE_SITE` / `INBOUND_PHONE_GREETING` | voice persona (Tron Netter / ai.xl.net) |
| Email | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (svix inbound), `MAIL_FROM` (`Tron Netter <Tron.Netter@ai.xl.net>`), `CONTACT_NOTIFY_EMAIL`, `OUTBOUND_BCC_EMAIL` (default adam@xl.net — mandatory oversight BCC) | ai.xl.net domain verified in Resend |
| Auth | `SESSION_COOKIE_SECRET` (≥32 chars), `ADMIN_EMAIL` (comma list — gates `/admin` + `/api/admin/*`, currently adam@xl.net) | |
| Admin | `INTERNAL_TRACK_SECRET` | auth for middleware→`/api/internal/track` beacons; unset = visit tracking off (SEO/Companies pages stay empty) |
| | `MAXMIND_DB_PATH` | optional; default `<cwd>/data/GeoLite2-ASN.mmdb` (IP→org for /admin/companies) |
| | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | `https://ai.xl.net/auth/google/callback` (GCP project `xl-website-1682362315172`, client "ai.xl.net") |
| | `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_REDIRECT_URI` / `MICROSOFT_TENANT_ID` (default `common`) | Entra app `e66a2e8f-c1c1-4b63-9ffe-245db7d5363c` |
| Site | `NEXT_PUBLIC_BASE_URL` (`https://ai.xl.net`), `NEXT_PUBLIC_SITE_NAME` (`XL.net AI`) | |
| | `TRON_KNOWLEDGE_FILE` | **legacy, no longer read** — the knowledge path is `persona.knowledgeFile` in site.config.ts |
| Crawl | `KNOWLEDGE_NOTIFY_EMAIL` / `ADMIN_EMAIL` | report recipient fallbacks |
| Misc | `AUTOMATION_SECRET` (skills-host), `DEFAULT_BRAIN_NAME`, `DEFAULT_PURPOSE` | brain persona defaults |
| Build | `SKIP_ENV_VALIDATION` | set by `next build` only — skips the module's runtime env validation |
| Deploy | `AIWEBSITE_SSH_IP` (52.237.160.75), `AIWEBSITE_USER` (xladmin), `AIWEBSITE_PW` (legacy sshpass transport — current; deploy.sh requires `--allow-sshpass`), `AIWEBSITE_SSH_KEY` (key path once the ssh-key transport is adopted) | consumed only by deploy.sh on the dev box, read literally |

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
systemctl list-timers 'aiwebsite-*'             # all 5 timers present (§9.7)
psql -c "select count(*) from brain_memories where scope='public'"   # ≥7 seed rows
ls -la /var/lib/aiwebsite/last-backup-ok        # after the first backup window (needs BACKUP_BUCKET)
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

## 14. Module dependency & design review personas

**This site consumes @aicompany/core v0.1.0 (submodule `packages/aicompany` @ `e5ccbd2`).**
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
