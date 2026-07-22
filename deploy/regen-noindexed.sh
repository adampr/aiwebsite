#!/usr/bin/env bash
# Resolve published-noindexed blog posts on prod (ARCHITECTURE.md blog section;
# owner-directed 2026-07-22): per slug, run the module's targeted regenerate
# (fresh writer draft with fresh gate results — v1.10+ escalation ladder when
# quality.maxRegenerates > 0), then the v1.12 headless publish CLI, which
# re-runs the gates and REFUSES (exit 2) rather than publish noindexed again.
#
#   bash deploy/regen-noindexed.sh <slug> [<slug> ...]
#
# Rules (panel-designed, normative for this script):
#   - Explicit slug allowlist only; refuses to run with zero args.
#   - Strictly sequential — the pg advisory lock serializes runs anyway.
#   - NEVER passes --allow-noindex; that §19.5 posture flag is a human
#     decision typed by hand, not a script default.
#   - A per-slug failure is recorded and the next slug proceeds; the final
#     exit is non-zero if any slug failed.
#   - The enumeration header prints ground truth BEFORE any write scrolls by.
#   - While a regenerated row sits as a draft its public URL 404s — the
#     publish follows the regenerate immediately, same remote session.
set -uo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { { grep -E "^$1=" "$repo_dir/.env" || true; } | head -1 | cut -d= -f2-; }
ssh_key="$(envval AIWEBSITE_SSH_KEY)"; ssh_key="${ssh_key:-~/.ssh/id_ed25519}"; ssh_key="${ssh_key/#\~/$HOME}"

if [ "$#" -eq 0 ]; then
  echo "usage: bash deploy/regen-noindexed.sh <slug> [<slug> ...]" >&2
  echo "refusing to run with an empty slug allowlist" >&2
  exit 64
fi
for slug in "$@"; do
  if ! [[ "$slug" =~ ^[a-z0-9-]{1,200}$ ]]; then
    echo "invalid slug (must match [a-z0-9-]{1,200}): $slug" >&2
    exit 64
  fi
done

failed=0
ssh -i "$ssh_key" -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" "
  set -u
  cd /var/www/aiwebsite
  DB=\"\$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)\"
  echo '== ground truth: published-noindexed + draft rows (before) =='
  psql \"\$DB\" -tAc \"SELECT slug || ' | ' || status || ' | noindex=' || noindex || ' | gate_passed=' || coalesce(gate_passed::text,'null') FROM blog_posts WHERE (status='published' AND noindex) OR status='draft' ORDER BY updated_at DESC\"
  overall=0
  for slug in $*; do
    echo \"== \$slug: regenerate ==\"
    if ! npx tsx packages/aicompany/scripts/blog-nightly.ts --generate-only --skip-daily-limit --no-email \"--regenerate=\$slug\"; then
      echo \"== \$slug: REGENERATE FAILED — row untouched, skipping publish ==\"
      overall=1
      continue
    fi
    st=\"\$(psql \"\$DB\" -tAc \"SELECT status FROM blog_posts WHERE slug='\$slug'\")\"
    if [ \"\$st\" != 'draft' ]; then
      echo \"== \$slug: no fresh draft landed (status=\$st — e.g. zero-source WARN-skip left the row as-is); skipping publish ==\"
      overall=1
      continue
    fi
    echo \"== \$slug: publish ==\"
    npx tsx packages/aicompany/scripts/blog-publish.ts \"--slug=\$slug\"
    rc=\$?
    if [ \$rc -ne 0 ]; then
      echo \"== \$slug: PUBLISH exit \$rc (2 = refused: fresh gates would land noindexed; row left as draft) ==\"
      overall=1
    fi
  done
  echo '== ground truth: published-noindexed + draft rows (after) =='
  psql \"\$DB\" -tAc \"SELECT slug || ' | ' || status || ' | noindex=' || noindex || ' | gate_passed=' || coalesce(gate_passed::text,'null') FROM blog_posts WHERE (status='published' AND noindex) OR status='draft' ORDER BY updated_at DESC\"
  exit \$overall
" || failed=1

exit $failed
