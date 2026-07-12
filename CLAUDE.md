# CLAUDE.md

## Keep ARCHITECTURE.md in sync (required)

`ARCHITECTURE.md` is the cleanroom-rebuild specification for this system. **Before
finishing any change, check whether it affects something ARCHITECTURE.md documents,
and update the doc in the same commit.** Changes that almost always require an update:

- pages, API routes, or their request/response/streaming shapes
- `src/lib/` module contracts, cookies, rate limits, timeouts
- DB schema (site tables or anything touching `brain_memories`)
- environment variables (also update `.env.example`)
- deploy scripts, PM2 processes, nginx, cloudflared, watchdog, cron schedules
- the brain envelope fields the site sends, or ports/topology
- external accounts/webhooks (Twilio, Resend, OAuth clients, Cloudflare)

Purely visual/copy tweaks don't need a doc update. When code and the doc disagree,
the code wins — fix the doc. Bump the "Last verified" date at the top when you touch it.

## Enforcement

A pre-commit hook (`scripts/git-hooks/pre-commit`, activated by the npm `prepare`
script via `git config core.hooksPath scripts/git-hooks`) blocks commits that touch
`src/`, `drizzle/`, `deploy/`, `packages/`, `site.config.ts`, or `instrumentation.ts`
without staging `ARCHITECTURE.md`. For changes with genuinely no architectural
impact: `ARCH_SYNC_OK=1 git commit ...`.

This rule is mirrored in `.cursor/rules/architecture-doc-sync.mdc` for Cursor
sessions — keep the two in sync when either changes.

## Never commit secrets (required)

**`.env` files, private keys, API keys, passwords, and tokens must never be
committed — no exceptions.** Real values live only in the dev box's `.env`
(gitignored) and on the VM; code reads them from the environment.

- `.gitignore` blocks the common filenames (`.env`, `.env.*`, `*.pem`, `*.key`,
  editor swap files, …).
- The pre-commit hook (`scripts/git-hooks/pre-commit`, Gate 1) rejects staged
  dotenv/key files and added lines matching known secret formats (Anthropic,
  Stripe, AWS, Google, GitHub, Slack, Resend, Twilio, private-key blocks, and
  generic quoted `PASSWORD=`/`API_KEY=` literals).
- Two env-named files stay tracked because they hold **no** secrets — keep it
  that way: `.env.example` (placeholder template) and `deploy/site-deploy.env`
  (non-secret deploy config).
- `SECRETS_OK=1 git commit ...` bypasses the scan for false positives ONLY —
  never use it to ship a real value. If a secret ever lands in git history,
  rotate it immediately; removing the commit is not enough.

This rule is mirrored in `.cursor/rules/no-secrets.mdc` — keep the two in sync.

## Other conventions

- `.env.example` is the authoritative env template: every variable the code reads
  must appear there with a comment.
- `data/*.md` are VM-generated (nightly crawl) — never hand-edit or commit content changes.
- `packages/brain` is a submodule with its own repo and canonical docs; don't document
  its internals here, only the contract the site consumes (ARCHITECTURE.md §7).
- `packages/aicompany` (@aicompany/core) is likewise a submodule with its own repo and
  canonical docs — treat it like `packages/brain`: don't modify it or document its
  internals here, only what this host configures/mounts (contract in the module's
  architecture.md; upgrade steps per version in its MIGRATIONS.md).
