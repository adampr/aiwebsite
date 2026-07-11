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
