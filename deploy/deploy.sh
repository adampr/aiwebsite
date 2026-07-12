#!/usr/bin/env bash
# aicompany-template: deploy.sh.tpl@c8e701bd502342ee3d759379a83f72e360ca16217e9d4e25f37fbeca2863dd1a
#
# Deploy ai.xl.net from the dev box to the production VM.
#
#   bash deploy/deploy.sh [--allow-sshpass]
#
# Transport ("ssh-key", rendered from deploy/site-deploy.env):
#   ssh-key    (default) key auth via SSH_KEY_PATH; reads AIWEBSITE_SSH_IP /
#              AIWEBSITE_USER from .env
#   sshpass    LEGACY password auth via AIWEBSITE_PW; refuses to run
#              without the explicit --allow-sshpass flag
#   gcloud-iap `gcloud compute ssh` IAP tunneling for GCP VMs with no
#              external IP (files ship as tar streams; no rsync --delete)
#
# Syncs the repo (incl. packages/brain submodule working tree), the production
# .env, the MaxMind DB, and the pre-provisioned Cloudflare tunnel credentials,
# then runs deploy/setup-vm.sh on the VM (which runs config:check BEFORE the
# PM2 reload). DNS is always a human step — this script never writes DNS.
#
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
app_dir="/var/www/aiwebsite"
module_dir="$repo_dir/packages/aicompany"
transport="ssh-key"
tunnel_cred_local="${TUNNEL_CRED_LOCAL:-$HOME/.cloudflared/aiwebsite-tunnel.json}"

# ── Template drift gate (§9): rendered deploy/ files must match the module's
# current templates, or a module bump would silently run stale scripts.
echo ">>> Checking rendered deploy scripts against module templates..."
stale=0
for f in "$repo_dir"/deploy/*; do
  [ -f "$f" ] || continue
  line=$(grep -m1 -E '^(#|//) aicompany-template: ' "$f" 2>/dev/null || true)
  [ -n "$line" ] || continue
  ref="$(printf '%s' "$line" | sed 's/^.*aicompany-template: //')"
  name="$(printf '%s' "$ref" | cut -d@ -f1)"
  want="$(printf '%s' "$ref" | cut -d@ -f2)"
  tpl="$module_dir/deploy/templates/$name"
  if [ ! -f "$tpl" ]; then
    echo "ERROR: deploy/$(basename "$f") references a template that no longer exists: $name"
    stale=1
    continue
  fi
  have="$(sha256sum "$tpl" | cut -d' ' -f1)"
  if [ "$want" != "$have" ]; then
    echo "ERROR: deploy/$(basename "$f") was rendered from an outdated $name"
    stale=1
  fi
done
if [ "$stale" -ne 0 ]; then
  echo ""
  echo "Rendered deploy scripts are out of date with the module templates —"
  echo "re-run render.mjs and commit:"
  echo "  node packages/aicompany/deploy/render.mjs && git add deploy/ && git commit"
  exit 1
fi
echo "  stamps OK"

# ── Dev-box credentials: read values literally — do NOT `source` .env:
# passwords may contain shell-special characters ($, #, *) that expansion
# would mangle.
envval() { grep -E "^$1=" "$repo_dir/.env" | head -1 | cut -d= -f2-; }

# ── Transport wrappers ───────────────────────────────────────────
case "$transport" in
  ssh-key)
    ssh_ip="$(envval AIWEBSITE_SSH_IP)"
    ssh_user="$(envval AIWEBSITE_USER)"
    ssh_key="$(envval AIWEBSITE_SSH_KEY)"
    ssh_key="${ssh_key:-~/.ssh/id_ed25519}"
    # site-deploy.env ships a ~-prefixed default; inside quotes bash never
    # tilde-expands, so do it explicitly before the -f test.
    ssh_key="${ssh_key/#\~/$HOME}"
    : "${ssh_ip:?set AIWEBSITE_SSH_IP in .env}"
    : "${ssh_user:?set AIWEBSITE_USER in .env}"
    [ -f "$ssh_key" ] || { echo "ERROR: SSH key $ssh_key not found (set AIWEBSITE_SSH_KEY in .env or SSH_KEY_PATH in deploy/site-deploy.env)"; exit 1; }
    ssh_e="ssh -i $ssh_key -o StrictHostKeyChecking=accept-new"
    run_remote() { $ssh_e "$ssh_user@$ssh_ip" "$@"; }
    sync_dir()  { rsync -az --delete "${rsync_excludes[@]}" -e "$ssh_e" "$1" "$ssh_user@$ssh_ip:$2"; }
    push_file() { rsync -az -e "$ssh_e" "$1" "$ssh_user@$ssh_ip:$2"; }
    ;;
  sshpass)
    allow_flag="no"
    for arg in "$@"; do [ "$arg" = "--allow-sshpass" ] && allow_flag="yes"; done
    if [ "$allow_flag" != "yes" ]; then
      echo "ERROR: DEPLOY_TRANSPORT=sshpass is a legacy transport (password auth)."
      echo "Re-run with --allow-sshpass to confirm, or switch to ssh-key in deploy/site-deploy.env."
      exit 1
    fi
    ssh_ip="$(envval AIWEBSITE_SSH_IP)"
    ssh_user="$(envval AIWEBSITE_USER)"
    ssh_pw="$(envval AIWEBSITE_PW)"
    : "${ssh_ip:?set AIWEBSITE_SSH_IP in .env}"
    : "${ssh_user:?set AIWEBSITE_USER in .env}"
    : "${ssh_pw:?set AIWEBSITE_PW in .env}"
    export SSHPASS="$ssh_pw"
    run_remote() { sshpass -e ssh -o StrictHostKeyChecking=accept-new "$ssh_user@$ssh_ip" "$@"; }
    sync_dir()  { sshpass -e rsync -az --delete "${rsync_excludes[@]}" "$1" "$ssh_user@$ssh_ip:$2"; }
    push_file() { sshpass -e rsync -az "$1" "$ssh_user@$ssh_ip:$2"; }
    ;;
  gcloud-iap)
    gcloud_args=(--project "" --zone "" --tunnel-through-iap)
    run_remote() { gcloud compute ssh "" "${gcloud_args[@]}" --command "$*"; }
    # No rsync over IAP: ship a tar stream. --delete semantics are lost; the
    # exclude list still keeps VM-owned paths (data/, .env) untouched.
    sync_dir() {
      tar czf - -C "$1" "${tar_excludes[@]}" . | run_remote "mkdir -p $2 && tar xzf - -C $2"
    }
    push_file() { run_remote "cat > $2$(basename "$1")" < "$1"; }
    ;;
  *)
    echo "ERROR: unknown DEPLOY_TRANSPORT '$transport' (expected ssh-key | sshpass | gcloud-iap)"
    exit 1
    ;;
esac

# data/ holds the VM-generated knowledge docs (nightly crawl) and the config
# snapshot; it exists only on the VM, so --delete must not remove it.
rsync_excludes=(
  --exclude .git --exclude node_modules --exclude .next
  --exclude .env --exclude /data/
  --exclude packages/brain/node_modules
  --exclude packages/brain/scripts/benchmark/cache
)
tar_excludes=(
  --exclude ./.git --exclude "node_modules" --exclude ./.next
  --exclude ./.env --exclude ./data
  --exclude "./packages/brain/scripts/benchmark/cache"
)

echo ">>> Preparing $app_dir on VM..."
run_remote "sudo mkdir -p $app_dir && sudo chown \$(whoami): $app_dir"

echo ">>> Syncing repo..."
sync_dir "$repo_dir/" "$app_dir/"

echo ">>> Copying production .env..."
push_file "$repo_dir/.env" "$app_dir/"

# GeoLite2-ASN is gitignored (12 MB binary) but lives inside the otherwise
# VM-owned data/, so it is shipped explicitly. Powers /admin/companies
# IP→organization lookups.
if [ -f "$repo_dir/data/GeoLite2-ASN.mmdb" ]; then
  echo ">>> Copying GeoLite2-ASN.mmdb..."
  run_remote "mkdir -p $app_dir/data"
  push_file "$repo_dir/data/GeoLite2-ASN.mmdb" "$app_dir/data/"
fi

if [ -f "$tunnel_cred_local" ]; then
  echo ">>> Copying Cloudflare tunnel credentials..."
  push_file "$tunnel_cred_local" "/tmp/"
  run_remote "sudo mkdir -p /etc/cloudflared && sudo mv /tmp/$(basename "$tunnel_cred_local") /etc/cloudflared/aiwebsite-tunnel.json && sudo chmod 600 /etc/cloudflared/aiwebsite-tunnel.json"
else
  echo "NOTE: $tunnel_cred_local not found — setup-cloudflared.sh will fall back to interactive login."
fi

echo ">>> Running setup-vm.sh on VM (installs everything, config:check gates the PM2 reload)..."
run_remote "cd $app_dir && bash deploy/setup-vm.sh"

echo ""
echo ">>> Verifying..."
run_remote "curl -fsS http://127.0.0.1:3000/api/health && echo && curl -fsS http://127.0.0.1:3211/health | head -c 300 && echo"
echo ""
echo "=== Deploy complete. Public check: curl -fsS https://ai.xl.net/api/health ==="
