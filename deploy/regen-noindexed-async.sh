#!/usr/bin/env bash
# Detached variant of regen-noindexed.sh: launches the per-slug
# regenerate→publish loop on the VM under nohup (panel-forced writer calls
# make one slug take many minutes — an interactive ssh would be killed by
# local timeouts mid-write). Prints the remote log path and returns
# immediately; poll with deploy/read-prod-blog-status.sh. A `<log>.done`
# marker file appears when the loop finishes (its content is the exit code).
#
#   bash deploy/regen-noindexed-async.sh <slug> [<slug> ...]
#
# Same normative rules as regen-noindexed.sh: explicit allowlist, sequential,
# NEVER --allow-noindex, per-slug failure isolation.
set -uo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { { grep -E "^$1=" "$repo_dir/.env" || true; } | head -1 | cut -d= -f2-; }
ssh_key="$(envval AIWEBSITE_SSH_KEY)"; ssh_key="${ssh_key:-~/.ssh/id_ed25519}"; ssh_key="${ssh_key/#\~/$HOME}"

if [ "$#" -eq 0 ]; then
  echo "usage: bash deploy/regen-noindexed-async.sh <slug> [<slug> ...]" >&2
  exit 64
fi
for slug in "$@"; do
  if ! [[ "$slug" =~ ^[a-z0-9-]{1,200}$ ]]; then
    echo "invalid slug (must match [a-z0-9-]{1,200}): $slug" >&2
    exit 64
  fi
done

ssh -i "$ssh_key" -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" "
  set -u
  cd /var/www/aiwebsite
  ts=\$(date +%s)
  log=/tmp/regen-noindexed-\$ts.log
  cat > /tmp/regen-noindexed-\$ts.sh <<'REMOTE'
#!/usr/bin/env bash
set -u
cd /var/www/aiwebsite
DB=\"\$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)\"
echo \"== ground truth (before) ==\"
psql \"\$DB\" -tAc \"SELECT slug || ' | ' || status || ' | noindex=' || noindex || ' | gate_passed=' || coalesce(gate_passed::text,'null') FROM blog_posts WHERE (status='published' AND noindex) OR status='draft' ORDER BY updated_at DESC\"
overall=0
for slug in \"\$@\"; do
  echo \"== \$slug: regenerate (\$(date +%H:%M:%S)) ==\"
  if ! npx tsx packages/aicompany/scripts/blog-nightly.ts --generate-only --skip-daily-limit --no-email \"--regenerate=\$slug\"; then
    echo \"== \$slug: REGENERATE FAILED — skipping publish ==\"
    overall=1
    continue
  fi
  st=\"\$(psql \"\$DB\" -tAc \"SELECT status FROM blog_posts WHERE slug='\$slug'\")\"
  if [ \"\$st\" != 'draft' ]; then
    echo \"== \$slug: no fresh draft (status=\$st) — skipping publish ==\"
    overall=1
    continue
  fi
  echo \"== \$slug: publish (\$(date +%H:%M:%S)) ==\"
  npx tsx packages/aicompany/scripts/blog-publish.ts \"--slug=\$slug\"
  rc=\$?
  if [ \$rc -ne 0 ]; then
    echo \"== \$slug: PUBLISH exit \$rc ==\"
    overall=1
  fi
done
echo \"== ground truth (after) ==\"
psql \"\$DB\" -tAc \"SELECT slug || ' | ' || status || ' | noindex=' || noindex || ' | gate_passed=' || coalesce(gate_passed::text,'null') FROM blog_posts WHERE (status='published' AND noindex) OR status='draft' ORDER BY updated_at DESC\"
exit \$overall
REMOTE
  chmod +x /tmp/regen-noindexed-\$ts.sh
  nohup bash -c \"/tmp/regen-noindexed-\$ts.sh $* > \$log 2>&1; echo \\\$? > \$log.done\" >/dev/null 2>&1 &
  echo \"launched: \$log (marker \$log.done on completion)\"
"
