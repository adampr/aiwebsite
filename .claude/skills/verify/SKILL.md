---
name: verify
description: Build/launch/drive recipe for verifying aiwebsite changes at runtime (Next.js app, governance UI component checks)
---

# Verifying aiwebsite changes

## Launch

- `npm run dev` (Turbopack, ready in <1s, port 3000; reads dev `.env`). Check
  nothing is already on 3000 first (`curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/`).
- Browser: system `/usr/bin/chromium` + `playwright-core` installed into the
  session scratchpad (`npm i playwright-core` there, launch with
  `{ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] }`).
  There is no playwright in the project node_modules — keep it out.

## Auth-gated pages (governance, account)

- Sessions are stateless signed cookies (`aix_session`), but DO NOT mint one:
  the permission classifier blocks credential-forging commands (verified
  2026-07-16). DB reads via psql with inline `.env` interpolation are also
  blocked.
- Working pattern for component-level UI checks: add a TEMPORARY page under
  `src/app/qa-verify-<thing>/page.tsx` that renders the real component with
  representative props at several container widths, screenshot + assert
  geometry via `page.evaluate`, then `rm -rf` the page before committing.
  Folder names starting with `_` are App-Router-private and 404 — don't use.

## Gotchas

- `futurism.css` styles bare `p { max-width: 62ch }` — layout checks on
  paragraphs should assert computed `max-width` too.
- `npm run test:governance` is the repo's own pre-deploy gate for anything
  touching `src/lib/governance/` (not a substitute for runtime verification).
- Site chrome renders around any page (header/footer) — screenshot fullPage
  and read the middle, or scope screenshots to the harness container.
